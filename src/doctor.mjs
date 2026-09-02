import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { appPaths } from "./app-paths.mjs";
import { parseClaudeAgents } from "./claude-session-service.mjs";
import { CodexAppServerClient } from "./codex-app-server.mjs";
import { ControlClient } from "./control-client.mjs";
import { DAEMON_PROTOCOL_VERSION, VERSION } from "./product.mjs";

function command(args) {
  const result = spawnSync(args[0], args.slice(1), {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
  return {
    ok: result.status === 0,
    detail: (result.stdout || result.stderr || result.error?.message || "not found").trim(),
    stdout: result.stdout,
  };
}

function socketReachable(socketPath) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => resolve(false));
  });
}

async function daemonProbe(paths) {
  if (!await socketReachable(paths.controlSocketPath)) return { ok: true, detail: "not running" };
  const client = new ControlClient(paths.controlSocketPath);
  try {
    await client.connect();
    const state = await client.request("state/get");
    const version = state.version ?? "unknown";
    const protocolVersion = state.protocolVersion ?? "unknown";
    return {
      ok: version === VERSION && protocolVersion === DAEMON_PROTOCOL_VERSION,
      detail: `${version}, protocol ${protocolVersion} at ${paths.controlSocketPath}`,
    };
  } catch (error) {
    return { ok: false, detail: `unreadable: ${error.message}` };
  } finally {
    client.close();
  }
}

async function codexAppServerProbe(cwd) {
  const client = CodexAppServerClient.spawn({ cwd });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("initialize timeout")), 5_000);
  try {
    const initialized = await client.initialize({ signal: controller.signal });
    return {
      ok: initialized !== null && typeof initialized === "object",
      detail: initialized?.userAgent ?? "initialize completed",
    };
  } catch (error) {
    return { ok: false, detail: error.message };
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
  }
}

function directoryProbe(directory) {
  let candidate = directory;
  while (!fs.existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return { ok: false, detail: `${directory} (no writable ancestor)` };
    candidate = parent;
  }
  try {
    fs.accessSync(candidate, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
    return { ok: true, detail: fs.existsSync(directory) ? directory : `${directory} (will be created)` };
  } catch (error) {
    return { ok: false, detail: `${directory}: ${error.message}` };
  }
}

export function defaultDoctorProbes({ paths, cwd }) {
  return {
    node: async () => ({
      ok: Number(process.versions.node.split(".")[0]) >= 22,
      detail: process.version,
    }),
    codexCli: async () => command(["codex", "--version"]),
    claudeCli: async () => command(["claude", "--version"]),
    runtimeDirectory: async () => directoryProbe(paths.runtimeDirectory),
    stateDirectory: async () => directoryProbe(paths.stateDirectory),
    daemon: async () => daemonProbe(paths),
    codexAppServer: async () => codexAppServerProbe(cwd),
    claudeAgents: async () => {
      const result = command(["claude", "agents", "--json", "--all"]);
      if (!result.ok) return result;
      try {
        const rows = parseClaudeAgents(result.stdout);
        return { ok: true, detail: `${rows.length} sessions parsed` };
      } catch (error) {
        return { ok: false, detail: error.message };
      }
    },
  };
}

const CHECKS = [
  ["Node", "node"],
  ["Codex CLI", "codexCli"],
  ["Claude CLI", "claudeCli"],
  ["Runtime dir", "runtimeDirectory"],
  ["State dir", "stateDirectory"],
  ["Daemon", "daemon"],
  ["Codex App Server", "codexAppServer"],
  ["Claude agents JSON", "claudeAgents"],
];

export async function runDoctor({
  output = process.stdout,
  paths = appPaths(),
  cwd = process.cwd(),
  probes = defaultDoctorProbes({ paths, cwd }),
} = {}) {
  const checks = [];
  for (const [name, key] of CHECKS) {
    let result;
    try {
      result = await probes[key]();
    } catch (error) {
      result = { ok: false, detail: error.message };
    }
    const check = { name, ok: result.ok === true, detail: result.detail || "no detail" };
    checks.push(check);
    output.write(`${check.ok ? "OK" : "--"}  ${check.name}: ${check.detail}\n`);
  }
  return { exitCode: checks.every((check) => check.ok) ? 0 : 1, checks };
}
