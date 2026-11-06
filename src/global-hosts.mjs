import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { shellCommand } from "./tmux-workspace.mjs";

const execute = promisify(execFile);
const invalid = message => Object.assign(new Error(message), { code: "INVALID_HOSTS" });

export function validateHosts(config) {
  if (config?.version !== 1 || !Array.isArray(config.hosts) || config.hosts.length > 16) throw invalid("hosts requires version 1 and at most 16 hosts");
  const ids = new Set();
  const identity = host => {
    if (!host || typeof host.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(host.id) || ids.has(host.id)) throw invalid("Host IDs must be unique safe identifiers");
    if (typeof host.name !== "string" || !host.name.trim() || host.name.length > 80 || /[\x00-\x1f\x7f-\x9f]/.test(host.name)) throw invalid("Host name must be printable text of at most 80 characters");
    if (host.type !== undefined && !["pc", "wsl", "vm"].includes(host.type)) throw invalid("Host type must be pc, wsl or vm");
    if (host.tailscaleId !== undefined && (typeof host.tailscaleId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(host.tailscaleId))) throw invalid('Invalid Tailscale node ID');
    ids.add(host.id);
    return { id: host.id, name: host.name, ...(host.type === undefined ? {} : { type: host.type }), ...(host.tailscaleId ? { tailscaleId: host.tailscaleId } : {}) };
  };
  const local = identity(config.local);
  const hosts = config.hosts.map(host => {
    const base = identity(host);
    if (typeof host.ssh !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9._@-]*$/.test(host.ssh)) throw invalid("ssh must be an SSH alias or user@host destination");
    for (const field of ['command', 'node']) {
      const value = host[field];
      if (field === 'node' && value === undefined) continue;
      if (typeof value !== 'string' || !value || value.startsWith('-') || value.length > 4096 || /[\x00-\x1f\x7f-\x9f]/.test(value) || (value.includes('/') && !path.posix.isAbsolute(value))) throw invalid(`${field} must be an executable name or absolute path`);
    }
    if (host.transport !== undefined && host.transport !== 'tailscale') throw invalid('Invalid host transport');
    return { ...base, ssh: host.ssh, command: host.command, ...(host.node === undefined ? {} : { node: host.node }), ...(host.transport ? { transport: host.transport } : {}) };
  });
  return { version: 1, local, hosts };
}

export function loadHosts(file, { env = process.env, read = fs.readFileSync } = {}) {
  if (file && !path.isAbsolute(file)) throw invalid("--hosts requires an absolute path");
  const location = file ?? path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "wattari-gattari", "hosts.json");
  try {
    const value = read(location, "utf8");
    if (Buffer.byteLength(value) > 128 * 1024) throw invalid("Hosts configuration exceeds 128KiB");
    return validateHosts(JSON.parse(value));
  }
  catch (error) {
    if (!file && error.code === "ENOENT") return { version: 1, local: { id: "local", name: os.hostname() }, hosts: [] };
    throw error;
  }
}

export function remoteCommand(host, { interactive = false, sessionId = null, create = null, force = false, args = ["list", "--json"] } = {}) {
  if (sessionId !== null && (typeof sessionId !== 'string' || !/^(claude|codex):[^\s\x00-\x1f\x7f]{1,256}$/.test(sessionId))) throw invalid('Invalid remote session ID');
  if (create && (sessionId !== null || !['claude', 'codex'].includes(create.provider)
      || create.cwd != null && (typeof create.cwd !== 'string' || !path.posix.isAbsolute(create.cwd) || /[\x00-\x1f\x7f]/.test(create.cwd)))) throw invalid('Invalid remote session creation');
  // Hosts are validated when the registry is loaded; quote every remote argument.
  const command = interactive
    ? shellCommand("env", [`WAGA_REMOTE_HOST=${host.name}`, `WAGA_REMOTE_HOST_ID=${host.id}`, `WAGA_OPEN_SESSION=${sessionId ?? ''}`, `WAGA_OPEN_FORCE=${force ? '1' : ''}`,
      `WAGA_CREATE_SESSION=${create ? create.skipRouting ? 'defaults' : 'routed' : ''}`, `WAGA_CREATE_PROVIDER=${create?.provider ?? ''}`, `WAGA_CREATE_CWD=${create?.cwd ?? ''}`, host.command, "--backend", "tmux"])
    : shellCommand(host.command, args);
  if (host.transport === 'tailscale') return { command: 'tailscale', args: ['ssh', host.ssh, interactive ? '-tt' : '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', command] };
  return { command: "ssh", args: [interactive ? "-tt" : "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no", "-o", "ConnectTimeout=5", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=2", "--", host.ssh, command] };
}

// Run the existing CLI on its owning PC; do not create a second message queue.
export function runRemoteCommand(spec, { stdout = process.stdout, stderr = process.stderr } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, { stdio: ["ignore", stdout, stderr] });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal === "SIGINT" ? 130 : 1)));
  });
}

export async function queryHost(host, { run = execute } = {}) {
  let spec = remoteCommand(host, { args: ['host-status', '--json'] }), result;
  const options = { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" };
  try { result = await run(spec.command, spec.args, options); }
  catch (error) {
    // Old Waga rejects the new read-only command with its CLI usage exit code.
    if (error.code !== 2) throw error;
    spec = remoteCommand(host);
    result = await run(spec.command, spec.args, options);
  }
  const data = validateHostStatus(JSON.parse(result.stdout));
  if (data.sessions === null) throw Object.assign(Error(data.warnings?.[0]?.message || 'Remote discovery failed'), { release: data.release });
  return data;
}

export function validateHostStatus(data) {
  if (data?.host !== undefined && !['pc', 'wsl', 'vm'].includes(data.host?.type)) throw invalid('Remote status returned invalid PC type');
  if (data?.release && ((data.release.installedRevision !== null && typeof data.release.installedRevision !== 'string')
    || !Array.isArray(data.release.docks) || data.release.docks.some(dock => !dock || (dock.revision !== null && typeof dock.revision !== 'string')))) throw invalid('Remote status returned invalid release information');
  if (!(data?.sessions === null && data?.release) && (!Array.isArray(data?.sessions) || data.sessions.some(s => !s || typeof s.id !== "string" || typeof s.cwd !== "string" || typeof s.name !== "string"))) throw invalid("Remote list returned invalid sessions");
  if (!Array.isArray(data.warnings ?? []) || data.warnings?.some(w => !w || typeof w.message !== "string")) throw invalid("Remote list returned invalid warnings");
  return { sessions: data.sessions, warnings: data.warnings ?? [], ...(data.release ? { release: data.release } : {}), ...(data.host ? { host: data.host } : {}), ...(data.openSession === true ? { openSession: true } : {}), ...(data.createSession === true ? { createSession: true } : {}) };
}
