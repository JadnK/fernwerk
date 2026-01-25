import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  AuthorizedKey,
  ConnectInfo,
  FileEntry,
  HostProfile,
  KeyEntry,
  ListeningPort,
  Progress,
  Service,
  Settings,
  Snippet,
  Stats,
  TermEvent,
  TunnelDef,
  TunnelStatus,
  UsersOverview,
  VaultData,
} from "./types";

type Sudo = string | undefined;

export const api = {
  // Vault
  vaultLoad: () => invoke<VaultData>("vault_load"),
  hostSave: (host: HostProfile, secret?: { password?: string; passphrase?: string }) =>
    invoke<HostProfile>("host_save", { host, secret: secret ?? null }),
  hostDelete: (id: string) => invoke<void>("host_delete", { id }),
  hostForgetKey: (host: string, port: number) => invoke<void>("host_forget_key", { host, port }),
  snippetSave: (snippet: Snippet) => invoke<Snippet>("snippet_save", { snippet }),
  snippetDelete: (id: string) => invoke<void>("snippet_delete", { id }),
  settingsSave: (settings: Settings) => invoke<void>("settings_save", { settings }),
  vaultExport: (path: string) => invoke<void>("vault_export", { path }),
  vaultImport: (path: string) => invoke<number>("vault_import", { path }),

  // SSH
  connect: (hostId: string, password?: string, passphrase?: string) =>
    invoke<ConnectInfo>("ssh_connect", { hostId, password: password ?? null, passphrase: passphrase ?? null }),
  disconnect: (id: string) => invoke<void>("ssh_disconnect", { id }),
  exec: (id: string, command: string) =>
    invoke<{ code: number | null; stdout: string; stderr: string }>("ssh_exec", { id, command }),

  // Terminal
  termOpen: (connId: string, cols: number, rows: number, onEvent: Channel<TermEvent>) =>
    invoke<string>("term_open", { connId, cols, rows, onEvent }),
  termWrite: (connId: string, termId: string, data: string) =>
    invoke<void>("term_write", { connId, termId, data }),
  termResize: (connId: string, termId: string, cols: number, rows: number) =>
    invoke<void>("term_resize", { connId, termId, cols, rows }),
  termClose: (connId: string, termId: string) => invoke<void>("term_close", { connId, termId }),

  // SFTP
  sftpHome: (connId: string) => invoke<string>("sftp_home", { connId }),
  sftpList: (connId: string, path: string) => invoke<FileEntry[]>("sftp_list", { connId, path }),
  sftpMkdir: (connId: string, path: string) => invoke<void>("sftp_mkdir", { connId, path }),
  sftpTouch: (connId: string, path: string) => invoke<void>("sftp_touch", { connId, path }),
  sftpRename: (connId: string, from: string, to: string) => invoke<void>("sftp_rename", { connId, from, to }),
  sftpChmod: (connId: string, path: string, mode: number) => invoke<void>("sftp_chmod", { connId, path, mode }),
  sftpRemove: (connId: string, paths: string[]) => invoke<void>("sftp_remove", { connId, paths }),
  sftpReadText: (connId: string, path: string) => invoke<string>("sftp_read_text", { connId, path }),
  sftpWriteText: (connId: string, path: string, content: string) =>
    invoke<void>("sftp_write_text", { connId, path, content }),
  sftpDownload: (
    connId: string,
    remotePaths: string[],
    localDir: string,
    transferId: string,
    onProgress: Channel<Progress>,
  ) => invoke<void>("sftp_download", { connId, remotePaths, localDir, transferId, onProgress }),
  sftpUpload: (
    connId: string,
    localPaths: string[],
    remoteDir: string,
    transferId: string,
    onProgress: Channel<Progress>,
  ) => invoke<void>("sftp_upload", { connId, localPaths, remoteDir, transferId, onProgress }),
  sftpCancel: (connId: string, transferId: string) => invoke<void>("sftp_cancel", { connId, transferId }),

  // Monitoring
  stats: (connId: string) => invoke<Stats>("stats_fetch", { connId }),
  processKill: (connId: string, pid: number, signal: string, sudoPassword: Sudo) =>
    invoke<void>("process_kill", { connId, pid, signal, sudoPassword: sudoPassword ?? null }),
  services: (connId: string) => invoke<Service[]>("services_list", { connId }),
  serviceAction: (connId: string, unit: string, action: string, sudoPassword: Sudo) =>
    invoke<void>("service_action", { connId, unit, action, sudoPassword: sudoPassword ?? null }),
  serviceLogs: (connId: string, unit: string, lines: number, sudoPassword: Sudo) =>
    invoke<string>("service_logs", { connId, unit, lines, sudoPassword: sudoPassword ?? null }),

  // Tunnel
  tunnelStart: (connId: string, def: TunnelDef) => invoke<void>("tunnel_start", { connId, def }),
  tunnelStop: (id: string) => invoke<void>("tunnel_stop", { id }),
  tunnelList: () => invoke<TunnelStatus[]>("tunnel_list"),
  remotePorts: (connId: string) => invoke<ListeningPort[]>("remote_ports", { connId }),

  // Benutzer
  users: (connId: string, sudoPassword: Sudo) =>
    invoke<UsersOverview>("users_list", { connId, sudoPassword: sudoPassword ?? null }),
  userCreate: (
    connId: string,
    user: {
      name: string;
      fullName: string;
      shell: string;
      groups: string[];
      password: string;
      createHome: boolean;
      authorizedKey: string;
    },
    sudoPassword: Sudo,
  ) => invoke<void>("user_create", { connId, user, sudoPassword: sudoPassword ?? null }),
  userDelete: (connId: string, name: string, removeHome: boolean, sudoPassword: Sudo) =>
    invoke<void>("user_delete", { connId, name, removeHome, sudoPassword: sudoPassword ?? null }),
  userPassword: (connId: string, name: string, password: string, sudoPassword: Sudo) =>
    invoke<void>("user_password", { connId, name, password, sudoPassword: sudoPassword ?? null }),
  userLock: (connId: string, name: string, lock: boolean, sudoPassword: Sudo) =>
    invoke<void>("user_lock", { connId, name, lock, sudoPassword: sudoPassword ?? null }),
  userUpdate: (
    connId: string,
    update: { name: string; fullName?: string; shell?: string; groups?: string[] },
    sudoPassword: Sudo,
  ) => invoke<void>("user_update", { connId, update, sudoPassword: sudoPassword ?? null }),
  groupCreate: (connId: string, name: string, sudoPassword: Sudo) =>
    invoke<void>("group_create", { connId, name, sudoPassword: sudoPassword ?? null }),

  // Schlüssel
  keysGenerate: (name: string, comment: string) => invoke<KeyEntry>("keys_generate", { name, comment }),
  keysImport: (name: string, path: string, passphrase?: string) =>
    invoke<KeyEntry>("keys_import", { name, path, passphrase: passphrase ?? null }),
  keysDelete: (id: string, deleteFile: boolean) => invoke<void>("keys_delete", { id, deleteFile }),
  keyDeploy: (connId: string, publicKey: string) => invoke<boolean>("key_deploy", { connId, publicKey }),
  authorizedKeys: (connId: string) => invoke<AuthorizedKey[]>("authorized_keys_list", { connId }),
  authorizedKeyRemove: (connId: string, line: string) =>
    invoke<void>("authorized_keys_remove", { connId, line }),
};

export function errText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}
