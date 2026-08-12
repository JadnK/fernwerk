//! Benutzer- und Gruppenverwaltung auf Linux-Servern (useradd/usermod/userdel/chpasswd).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::ssh::sh_quote;
use crate::state::AppState;

const ADMIN_GROUPS: [&str; 3] = ["sudo", "wheel", "admin"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserInfo {
    pub name: String,
    pub uid: u32,
    pub gid: u32,
    pub gecos: String,
    pub home: String,
    pub shell: String,
    pub groups: Vec<String>,
    pub locked: Option<bool>,
    pub admin: bool,
    pub system: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInfo {
    pub name: String,
    pub gid: u32,
    pub members: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsersOverview {
    pub users: Vec<UserInfo>,
    pub groups: Vec<GroupInfo>,
    pub shells: Vec<String>,
    pub admin_group: String,
    pub shadow_readable: bool,
}

pub fn valid_name(n: &str) -> bool {
    let mut chars = n.chars();
    match chars.next() {
        Some(c) if c.is_ascii_lowercase() || c == '_' => {}
        _ => return false,
    }
    n.len() <= 32
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
}

fn valid_shell(s: &str) -> bool {
    s.starts_with('/')
        && s.len() < 128
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || "/_.-".contains(c))
}

fn valid_gecos(s: &str) -> bool {
    s.len() < 128 && !s.contains([':', '\n', '\r'])
}

fn parse_groups(s: &str) -> Vec<GroupInfo> {
    s.lines()
        .filter_map(|l| {
            let p: Vec<&str> = l.split(':').collect();
            if p.len() < 4 {
                return None;
            }
            Some(GroupInfo {
                name: p[0].to_string(),
                gid: p[2].parse().ok()?,
                members: p[3]
                    .split(',')
                    .filter(|m| !m.is_empty())
                    .map(String::from)
                    .collect(),
            })
        })
        .collect()
}

#[tauri::command]
pub async fn users_list(
    state: State<'_, AppState>,
    conn_id: String,
    sudo_password: Option<String>,
) -> AppResult<UsersOverview> {
    let conn = state.conn(&conn_id).await?;
    let out = conn
        .exec(
            "getent passwd; echo @@FW@@; getent group; echo @@FW@@; \
             grep -E '^/' /etc/shells 2>/dev/null; echo @@FW@@; \
             awk -F: '$1==\"UID_MIN\"{print $2}' /etc/login.defs 2>/dev/null",
            None,
        )
        .await?
        .check()?;
    let parts: Vec<&str> = out.stdout.split("@@FW@@").collect();
    if parts.len() < 4 {
        return Err(AppError::msg("Unerwartete Ausgabe vom Server"));
    }
    let uid_min: u32 = parts[3].trim().parse().unwrap_or(1000);
    let groups = parse_groups(parts[1]);
    let gid_names: HashMap<u32, &str> = groups.iter().map(|g| (g.gid, g.name.as_str())).collect();

    // Sperrstatus aus /etc/shadow – nur wenn root/sudo verfügbar, Fehler werden ignoriert
    let shadow: Option<HashMap<String, bool>> = conn
        .exec_root("cut -d: -f1,2 /etc/shadow", sudo_password, None)
        .await
        .ok()
        .filter(|o| o.ok())
        .map(|o| {
            o.stdout
                .lines()
                .filter_map(|l| l.split_once(':'))
                .map(|(n, h)| (n.to_string(), h.starts_with('!')))
                .collect()
        });

    let mut users: Vec<UserInfo> = parts[0]
        .lines()
        .filter_map(|l| {
            let p: Vec<&str> = l.split(':').collect();
            if p.len() < 7 {
                return None;
            }
            let name = p[0].to_string();
            let uid: u32 = p[2].parse().ok()?;
            let gid: u32 = p[3].parse().ok()?;
            let mut member_of: Vec<String> = groups
                .iter()
                .filter(|g| g.members.contains(&name))
                .map(|g| g.name.clone())
                .collect();
            if let Some(primary) = gid_names.get(&gid) {
                if !member_of.iter().any(|g| g == primary) {
                    member_of.insert(0, primary.to_string());
                }
            }
            let no_login = p[6].ends_with("/nologin") || p[6].ends_with("/false");
            Some(UserInfo {
                admin: uid == 0 || member_of.iter().any(|g| ADMIN_GROUPS.contains(&g.as_str())),
                system: uid != 0 && (uid < uid_min || uid == 65534 || no_login),
                locked: shadow.as_ref().and_then(|s| s.get(&name).copied()),
                name,
                uid,
                gid,
                gecos: p[4].split(',').next().unwrap_or("").to_string(),
                home: p[5].to_string(),
                shell: p[6].to_string(),
                groups: member_of,
            })
        })
        .collect();
    users.sort_by_key(|u| (u.system, u.uid));

    let admin_group = ADMIN_GROUPS
        .iter()
        .find(|g| groups.iter().any(|x| x.name == **g))
        .unwrap_or(&"sudo")
        .to_string();

    Ok(UsersOverview {
        users,
        shells: parts[2]
            .lines()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect(),
        groups,
        admin_group,
        shadow_readable: shadow.is_some(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewUser {
    pub name: String,
    #[serde(default)]
    pub full_name: String,
    pub shell: String,
    #[serde(default)]
    pub groups: Vec<String>,
    #[serde(default)]
    pub password: String,
    #[serde(default = "yes")]
    pub create_home: bool,
    #[serde(default)]
    pub authorized_key: String,
}

fn yes() -> bool {
    true
}

fn check_groups(groups: &[String]) -> AppResult<()> {
    if groups.iter().all(|g| valid_name(g)) {
        Ok(())
    } else {
        Err(AppError::msg("Ungültiger Gruppenname"))
    }
}

#[tauri::command]
pub async fn user_create(
    state: State<'_, AppState>,
    conn_id: String,
    user: NewUser,
    sudo_password: Option<String>,
) -> AppResult<()> {
    if !valid_name(&user.name) {
        return Err(AppError::msg(
            "Ungültiger Benutzername (a-z, 0-9, _ und -, max. 32 Zeichen)",
        ));
    }
    if !valid_shell(&user.shell) {
        return Err(AppError::msg("Ungültige Shell"));
    }
    if !valid_gecos(&user.full_name) {
        return Err(AppError::msg("Ungültiger Name"));
    }
    check_groups(&user.groups)?;
    if user.password.contains('\n') {
        return Err(AppError::msg(
            "Passwort darf keinen Zeilenumbruch enthalten",
        ));
    }

    let mut cmd = format!(
        "useradd -s {} -c {}",
        sh_quote(&user.shell),
        sh_quote(&user.full_name)
    );
    cmd.push_str(if user.create_home { " -m" } else { " -M" });
    if !user.groups.is_empty() {
        cmd.push_str(&format!(" -G {}", sh_quote(&user.groups.join(","))));
    }
    cmd.push(' ');
    cmd.push_str(&sh_quote(&user.name));

    let mut stdin = None;
    if !user.password.is_empty() {
        cmd.push_str(" && chpasswd");
        stdin = Some(format!("{}:{}\n", user.name, user.password).into_bytes());
    }

    let key = user.authorized_key.trim();
    if !key.is_empty() {
        if key.contains('\n') || !key.starts_with("ssh-") && !key.starts_with("ecdsa-") {
            return Err(AppError::msg("Ungültiger Public Key"));
        }
        let n = sh_quote(&user.name);
        cmd.push_str(&format!(
            " && H=$(getent passwd {n} | cut -d: -f6) && mkdir -p \"$H/.ssh\" && \
             printf '%s\\n' {k} >> \"$H/.ssh/authorized_keys\" && \
             chmod 700 \"$H/.ssh\" && chmod 600 \"$H/.ssh/authorized_keys\" && \
             chown -R {n}: \"$H/.ssh\"",
            k = sh_quote(key)
        ));
    }

    let conn = state.conn(&conn_id).await?;
    conn.exec_root(&cmd, sudo_password, stdin.as_deref())
        .await?
        .check()?;
    Ok(())
}

#[tauri::command]
pub async fn user_delete(
    state: State<'_, AppState>,
    conn_id: String,
    name: String,
    remove_home: bool,
    sudo_password: Option<String>,
) -> AppResult<()> {
    if !valid_name(&name) || name == "root" {
        return Err(AppError::msg("Dieser Benutzer kann nicht gelöscht werden"));
    }
    let conn = state.conn(&conn_id).await?;
    if name == conn.username {
        return Err(AppError::msg(
            "Der angemeldete Benutzer kann nicht gelöscht werden",
        ));
    }
    let flag = if remove_home { "-r " } else { "" };
    conn.exec_root(
        &format!("userdel {flag}{}", sh_quote(&name)),
        sudo_password,
        None,
    )
    .await?
    .check()?;
    Ok(())
}

#[tauri::command]
pub async fn user_password(
    state: State<'_, AppState>,
    conn_id: String,
    name: String,
    password: String,
    sudo_password: Option<String>,
) -> AppResult<()> {
    if !valid_name(&name) {
        return Err(AppError::msg("Ungültiger Benutzername"));
    }
    if password.is_empty() || password.contains('\n') {
        return Err(AppError::msg("Ungültiges Passwort"));
    }
    let conn = state.conn(&conn_id).await?;
    let input = format!("{name}:{password}\n");
    conn.exec_root("chpasswd", sudo_password, Some(input.as_bytes()))
        .await?
        .check()?;
    Ok(())
}

#[tauri::command]
pub async fn user_lock(
    state: State<'_, AppState>,
    conn_id: String,
    name: String,
    lock: bool,
    sudo_password: Option<String>,
) -> AppResult<()> {
    if !valid_name(&name) || name == "root" {
        return Err(AppError::msg("Ungültiger Benutzer"));
    }
    let conn = state.conn(&conn_id).await?;
    let flag = if lock { "-L" } else { "-U" };
    conn.exec_root(
        &format!("usermod {flag} {}", sh_quote(&name)),
        sudo_password,
        None,
    )
    .await?
    .check()?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserUpdate {
    pub name: String,
    pub full_name: Option<String>,
    pub shell: Option<String>,
    /// Ersetzt die Zusatzgruppen komplett
    pub groups: Option<Vec<String>>,
}

#[tauri::command]
pub async fn user_update(
    state: State<'_, AppState>,
    conn_id: String,
    update: UserUpdate,
    sudo_password: Option<String>,
) -> AppResult<()> {
    if !valid_name(&update.name) {
        return Err(AppError::msg("Ungültiger Benutzername"));
    }
    let mut args = Vec::new();
    if let Some(s) = &update.shell {
        if !valid_shell(s) {
            return Err(AppError::msg("Ungültige Shell"));
        }
        args.push(format!("-s {}", sh_quote(s)));
    }
    if let Some(f) = &update.full_name {
        if !valid_gecos(f) {
            return Err(AppError::msg("Ungültiger Name"));
        }
        args.push(format!("-c {}", sh_quote(f)));
    }
    if let Some(g) = &update.groups {
        check_groups(g)?;
        args.push(format!("-G {}", sh_quote(&g.join(","))));
    }
    if args.is_empty() {
        return Ok(());
    }
    let conn = state.conn(&conn_id).await?;
    conn.exec_root(
        &format!("usermod {} {}", args.join(" "), sh_quote(&update.name)),
        sudo_password,
        None,
    )
    .await?
    .check()?;
    Ok(())
}

#[tauri::command]
pub async fn group_create(
    state: State<'_, AppState>,
    conn_id: String,
    name: String,
    sudo_password: Option<String>,
) -> AppResult<()> {
    if !valid_name(&name) {
        return Err(AppError::msg("Ungültiger Gruppenname"));
    }
    let conn = state.conn(&conn_id).await?;
    conn.exec_root(
        &format!("groupadd {}", sh_quote(&name)),
        sudo_password,
        None,
    )
    .await?
    .check()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert!(valid_name("deploy"));
        assert!(valid_name("_svc-1"));
        assert!(!valid_name("Root"));
        assert!(!valid_name("a;rm -rf /"));
        assert!(!valid_name(""));
        assert!(!valid_name("1abc"));
    }

    #[test]
    fn shells() {
        assert!(valid_shell("/bin/bash"));
        assert!(valid_shell("/usr/sbin/nologin"));
        assert!(!valid_shell("bash"));
        assert!(!valid_shell("/bin/sh; reboot"));
    }

    #[test]
    fn groups() {
        let g = parse_groups("sudo:x:27:alice,bob\ndocker:x:999:\n");
        assert_eq!(g.len(), 2);
        assert_eq!(g[0].members, vec!["alice", "bob"]);
        assert!(g[1].members.is_empty());
    }
}
