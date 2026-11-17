//! Sicherheits-Check: sammelt in einem einzigen Durchlauf Rohdaten vom Server
//! (sshd-Konfiguration, Firewall, offene Ports, fail2ban, Updates, Angriffs-Indizien).
//! Die Bewertung passiert im Frontend (`src/lib/security.ts`), hier wird nur gelesen – nichts verändert.

use std::collections::BTreeMap;

use tauri::State;

use crate::error::AppResult;
use crate::ssh::sh_quote;
use crate::state::AppState;

/// Jede Sektion beginnt mit `@@name`. Alle Befehle sind nur lesend und mit `timeout` begrenzt,
/// fehlende Programme liefern einfach eine leere Sektion.
const SCRIPT: &str = r#"
export LC_ALL=C PATH="$PATH:/usr/sbin:/sbin"
t() { if command -v timeout >/dev/null 2>&1; then timeout 8 "$@"; else "$@"; fi; }
s() { printf '\n@@%s\n' "$1"; }
authlog() { t journalctl -q --no-pager --since '-24h' _COMM=sshd 2>/dev/null | grep . || cat /var/log/auth.log /var/log/secure 2>/dev/null; }
s whoami; id -u
s os; . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME"; uname -r
s uptime; cat /proc/loadavg; nproc 2>/dev/null
s sshd; t sshd -T 2>/dev/null | grep -Ei '^(port|permitrootlogin|passwordauthentication|kbdinteractiveauthentication|challengeresponseauthentication|pubkeyauthentication|permitemptypasswords|maxauthtries|x11forwarding|allowusers|allowgroups) '
s sshd_files; grep -hEi '^\s*(port|permitrootlogin|passwordauthentication|kbdinteractiveauthentication|pubkeyauthentication|permitemptypasswords|maxauthtries|x11forwarding)\s' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null
s ufw; command -v ufw >/dev/null 2>&1 && t ufw status verbose 2>&1
s firewalld; command -v firewall-cmd >/dev/null 2>&1 && t firewall-cmd --state 2>&1
s nft; command -v nft >/dev/null 2>&1 && t nft list ruleset 2>/dev/null | grep -cE '(drop|reject)'
s iptables; command -v iptables >/dev/null 2>&1 && t iptables -S INPUT 2>/dev/null | head -n 40
s listen; t ss -H -tulpn 2>/dev/null
s fail2ban; command -v fail2ban-client >/dev/null 2>&1 && t fail2ban-client status 2>&1
s fail2ban_sshd; command -v fail2ban-client >/dev/null 2>&1 && (t fail2ban-client status sshd 2>/dev/null || t fail2ban-client status ssh 2>/dev/null)
s crowdsec; command -v cscli >/dev/null 2>&1 && systemctl is-active crowdsec 2>/dev/null
s syn_recv; t ss -H -tn state syn-recv 2>/dev/null | wc -l
s established; t ss -H -tn state established 2>/dev/null | wc -l
s top_peers; t ss -H -tn state established 2>/dev/null | awk '{print $4}' | sed -E 's/:[0-9]+$//; s/^\[//; s/\]$//' | grep -vE '^(127\.|::1$|::ffff:127\.)' | sort | uniq -c | sort -rn | head -n 8
s failed_logins; authlog | grep -cE 'Failed password|Invalid user|authentication failure'
s failed_ips; authlog | grep -E 'Failed password|Invalid user' | grep -oE 'from [0-9a-fA-F:.]+' | cut -d' ' -f2 | sort | uniq -c | sort -rn | head -n 8
s sysctl; for k in net.ipv4.tcp_syncookies net.ipv4.conf.all.rp_filter net.ipv4.conf.all.accept_redirects net.ipv4.conf.all.send_redirects net.ipv4.icmp_echo_ignore_broadcasts kernel.randomize_va_space; do printf '%s=%s\n' "$k" "$(sysctl -n $k 2>/dev/null)"; done
s uid0; awk -F: '$3==0{print $1}' /etc/passwd
s empty_pw; [ -r /etc/shadow ] && awk -F: '($2==""){print $1}' /etc/shadow
s shadow_readable; [ -r /etc/shadow ] && echo yes
s nopasswd; grep -rhE '^[^#].*NOPASSWD' /etc/sudoers /etc/sudoers.d 2>/dev/null
s root_keys; [ -r /root/.ssh/authorized_keys ] && grep -cvE '^\s*(#|$)' /root/.ssh/authorized_keys
s updates_apt; command -v apt-get >/dev/null 2>&1 && { u=$(t apt-get -s -o Debug::NoLocking=1 upgrade 2>/dev/null | grep '^Inst'); printf '%s\n' "$u" | grep -c .; printf '%s\n' "$u" | grep -ci security; }
s updates_dnf; command -v dnf >/dev/null 2>&1 && { t dnf -q -C check-update 2>/dev/null | grep -cE '^\S+\.\S+\s'; t dnf -q -C updateinfo list --security 2>/dev/null | grep -c .; }
s auto_updates; if dpkg -s unattended-upgrades 2>/dev/null | grep -q 'ok installed' && grep -qs 'Unattended-Upgrade "1"' /etc/apt/apt.conf.d/*; then echo apt; fi; systemctl is-enabled dnf-automatic.timer dnf-automatic-install.timer 2>/dev/null | grep -q enabled && echo dnf
s reboot; [ -f /var/run/reboot-required ] && echo yes
s done
"#;

/// Führt den Check aus. `root = false` liest nur, was ohne sudo sichtbar ist.
#[tauri::command]
pub async fn security_audit(
    state: State<'_, AppState>,
    conn_id: String,
    root: bool,
    sudo_password: Option<String>,
) -> AppResult<BTreeMap<String, String>> {
    let conn = state.conn(&conn_id).await?;
    let out = if root {
        conn.exec_root(SCRIPT, sudo_password, None).await?
    } else {
        conn.exec(&format!("sh -c {}", sh_quote(SCRIPT)), None)
            .await?
    };
    Ok(parse_sections(&out.stdout))
}

fn parse_sections(raw: &str) -> BTreeMap<String, String> {
    let mut map = BTreeMap::new();
    let mut current: Option<String> = None;
    let mut buf = String::new();
    for line in raw.lines() {
        if let Some(name) = line.strip_prefix("@@") {
            if let Some(c) = current.take() {
                map.insert(c, buf.trim().to_string());
            }
            buf.clear();
            current = Some(name.trim().to_string());
        } else if current.is_some() {
            buf.push_str(line);
            buf.push('\n');
        }
    }
    if let Some(c) = current {
        map.insert(c, buf.trim().to_string());
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sections() {
        let m = parse_sections("noise\n@@a\n1\n2\n@@b\n\n@@done\n");
        assert_eq!(m["a"], "1\n2");
        assert_eq!(m["b"], "");
        assert!(m.contains_key("done"));
        assert!(!m.contains_key("noise"));
    }
}
