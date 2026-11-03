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
    ids.add(host.id);
    return { id: host.id, name: host.name, ...(host.type === undefined ? {} : { type: host.type }) };
  };
  const local = identity(config.local);
  const hosts = config.hosts.map(host => {
    const base = identity(host);
    if (typeof host.ssh !== "string" || !/^[a-zA-Z0-9_][a-zA-Z0-9._@-]*$/.test(host.ssh)) throw invalid("ssh must be an SSH alias or user@host destination");
    if (typeof host.command !== "string" || !host.command || host.command.startsWith("-") || host.command.length > 4096 || /[\x00-\x1f\x7f-\x9f]/.test(host.command) || (host.command.includes("/") && !path.posix.isAbsolute(host.command))) throw invalid("command must be an executable name or absolute path");
    return { ...base, ssh: host.ssh, command: host.command };
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

export function remoteCommand(host, { interactive = false, args = ["list", "--json"] } = {}) {
  // Hosts are validated when the registry is loaded; quote every remote argument.
  const command = interactive
    ? shellCommand("env", [`WAGA_REMOTE_HOST=${host.name}`, `WAGA_REMOTE_HOST_ID=${host.id}`, host.command, "--backend", "tmux"])
    : shellCommand(host.command, args);
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
  const spec = remoteCommand(host);
  const result = await run(spec.command, spec.args, { encoding: "utf8", timeout: 10_000, maxBuffer: 1024 * 1024, killSignal: "SIGKILL" });
  const data = JSON.parse(result.stdout);
  if (!Array.isArray(data?.sessions) || data.sessions.some(s => !s || typeof s.id !== "string" || typeof s.cwd !== "string" || typeof s.name !== "string")) throw invalid("Remote list returned invalid sessions");
  if (!Array.isArray(data.warnings ?? []) || data.warnings?.some(w => !w || typeof w.message !== "string")) throw invalid("Remote list returned invalid warnings");
  return { sessions: data.sessions, warnings: data.warnings ?? [] };
}
