import { spawnSync } from "node:child_process";

import { parseClaudeAgents } from "./providers/claude.mjs";
import { parseDaemonVersion } from "./providers/codex.mjs";

function command(args) {
  const result = spawnSync(args[0], args.slice(1), { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 10_000 });
  return { ok: result.status === 0, detail: (result.stdout || result.stderr || result.error?.message || "not found").trim(), stdout: result.stdout };
}

export function defaultDoctorProbes() {
  return {
    node: async () => ({ ok: Number(process.versions.node.split(".")[0]) >= 22, detail: process.version }),
    codexCli: async () => command(["codex", "--version"]),
    claudeCli: async () => command(["claude", "--version"]),
    codexAgents: async () => {
      const result = command(["codex", "agents", "--help"]);
      return result.ok ? { ok: true, detail: "available" } : result;
    },
    claudeAgents: async () => {
      const result = command(["claude", "agents", "--json", "--all"]);
      if (!result.ok) return result;
      try { return { ok: true, detail: `${parseClaudeAgents(result.stdout).length} sessions parsed` }; }
      catch (error) { return { ok: false, detail: error.message }; }
    },
    codexDaemon: async () => {
      const result = command(["codex", "app-server", "daemon", "version"]);
      if (!result.ok) return result;
      try {
        const daemon = parseDaemonVersion(result.stdout);
        return { ok: ["running", "stopped"].includes(daemon.status), detail: `${daemon.status}${daemon.socketPath ? ` at ${daemon.socketPath}` : ""}` };
      } catch (error) { return { ok: false, detail: error.message }; }
    },
  };
}

const CHECKS = [
  ["Node", "node"], ["Codex CLI", "codexCli"], ["Claude CLI", "claudeCli"],
  ["Codex Agents", "codexAgents"], ["Codex daemon", "codexDaemon"], ["Claude peer registry", "claudeAgents"],
];

export async function runDoctor({ output = process.stdout, probes = defaultDoctorProbes() } = {}) {
  const checks = [];
  for (const [name, key] of CHECKS) {
    let result;
    try { result = await probes[key](); } catch (error) { result = { ok: false, detail: error.message }; }
    const check = { name, ok: result.ok === true, detail: result.detail || "no detail" };
    checks.push(check);
    output.write(`${check.ok ? "OK" : "--"}  ${check.name}: ${check.detail}\n`);
  }
  return { exitCode: checks.every((check) => check.ok) ? 0 : 1, checks };
}
