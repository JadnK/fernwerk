export type AuthMethod = { type: "password" } | { type: "key"; keyPath: string };

export type TunnelKind = "local" | "dynamic";

export interface TunnelDef {
  id: string;
  name: string;
  kind: TunnelKind;
  bindHost: string;
  bindPort: number;
  remoteHost: string;
  remotePort: number;
  autoStart: boolean;
}

export interface HostProfile {
  id: string;
  name: string;
  group: string;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  color: string;
  tags: string[];
  tunnels: TunnelDef[];
  startupCommand: string;
  hasSecret: boolean;
  lastUsed: number | null;
}

export interface Snippet {
  id: string;
  name: string;
  command: string;
}

export interface KeyEntry {
  id: string;
  name: string;
  path: string;
  publicKey: string;
  fingerprint: string;
  created: number;
}

export interface Settings {
  fontSize: number;
  fontFamily: string;
  cursorBlink: boolean;
  scrollback: number;
  copyOnSelect: boolean;
}

export interface VaultData {
  hosts: HostProfile[];
  snippets: Snippet[];
  keys: KeyEntry[];
  knownHosts: Record<string, string>;
  settings: Settings;
}

export interface ConnectInfo {
  id: string;
  hostId: string;
  label: string;
  username: string;
  fingerprint: string;
  newHostKey: boolean;
}

export type TermEvent = { kind: "data"; data: string } | { kind: "exit"; code: number | null };

export interface FileEntry {
  name: string;
  path: string;
  kind: "dir" | "file" | "link";
  linkToDir: boolean;
  size: number;
  mtime: number | null;
  mode: number;
  perms: string;
  owner: string;
}

export interface Progress {
  transferId: string;
  file: string;
  done: number;
  total: number;
  finished: boolean;
  error: string | null;
}

export interface Disk {
  fs: string;
  mount: string;
  size: number;
  used: number;
}

export interface Proc {
  pid: number;
  user: string;
  cpu: number;
  mem: number;
  rss: number;
  command: string;
}

export interface Stats {
  hostname: string;
  kernel: string;
  os: string;
  cores: number;
  cpu: number | null;
  load: [number, number, number];
  uptime: number;
  mem: {
    total: number;
    used: number;
    available: number;
    cached: number;
    swapTotal: number;
    swapUsed: number;
  };
  disks: Disk[];
  rxRate: number | null;
  txRate: number | null;
  rxTotal: number;
  txTotal: number;
  procs: Proc[];
  sessions: number;
}

export interface Service {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
  enabled: string;
}

export interface TunnelStatus {
  id: string;
  connId: string;
  name: string;
  kind: TunnelKind;
  bindHost: string;
  bindPort: number;
  remoteHost: string;
  remotePort: number;
  active: number;
  totalConns: number;
  bytesUp: number;
  bytesDown: number;
  started: number;
}

export interface ListeningPort {
  address: string;
  port: number;
  process: string;
}

export interface UserInfo {
  name: string;
  uid: number;
  gid: number;
  gecos: string;
  home: string;
  shell: string;
  groups: string[];
  locked: boolean | null;
  admin: boolean;
  system: boolean;
}

export interface GroupInfo {
  name: string;
  gid: number;
  members: string[];
}

export interface UsersOverview {
  users: UserInfo[];
  groups: GroupInfo[];
  shells: string[];
  adminGroup: string;
  shadowReadable: boolean;
}

export interface AuthorizedKey {
  line: string;
  kind: string;
  comment: string;
  fingerprint: string;
}

export type Tool = "terminal" | "files" | "monitor" | "services" | "tunnels" | "users" | "access";
