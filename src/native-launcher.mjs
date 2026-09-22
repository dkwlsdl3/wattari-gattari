import { spawn } from "node:child_process";
import path from "node:path";

import { CodexProvider } from "./providers/codex.mjs";

function defaultLaunch(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal }));
  });
}

export async function openNativeAgents(provider, { cwd = process.cwd(), launch = defaultLaunch } = {}) {
  const spec = nativeAgentsCommand(provider, { cwd });
  return launch(spec.command, spec.args, { cwd: spec.cwd });
}

export function nativeAgentsCommand(provider, { cwd = process.cwd() } = {}) {
  const workspace = path.resolve(cwd);
  const command = provider === "claude" ? "claude" : provider === "codex" ? "codex" : null;
  if (!command) throw Object.assign(new Error(`Unknown provider: ${provider}`), { code: "PROVIDER_NOT_FOUND" });
  const args = provider === "claude" ? ["agents", "--cwd", workspace] : ["agents", "-C", workspace];
  return { command, args, cwd: workspace };
}

export async function nativeSessionCommand(session, { codexProvider = new CodexProvider(), codexExecutionMode } = {}) {
  if (!session || !["claude", "codex"].includes(session.provider)) {
    throw Object.assign(new Error("Native session requires a known provider"), { code: "PROVIDER_NOT_FOUND" });
  }
  if (typeof session.nativeId !== "string" || !session.nativeId.trim()) {
    throw Object.assign(new Error("Native session is missing its provider id"), { code: "SESSION_NOT_FOUND" });
  }
  if (typeof session.cwd !== "string" || !session.cwd.trim()) {
    throw Object.assign(new Error("Native session is missing its workspace"), { code: "SESSION_NOT_FOUND" });
  }

  const cwd = path.resolve(session.cwd);
  if (session.provider === "claude") {
    return { command: "claude", args: ["attach", session.nativeId], cwd };
  }

  const daemon = await codexProvider.daemonInfo({ start: true });
  if (daemon.status !== "running" || typeof daemon.socketPath !== "string" || !path.isAbsolute(daemon.socketPath)) {
    throw Object.assign(new Error("Codex native app-server daemon is unavailable"), { code: "CODEX_DAEMON_UNAVAILABLE" });
  }
  const args = ["resume", session.nativeId];
  if (codexExecutionMode === "yolo") {
    // An explicit --remote endpoint makes Codex treat the local daemon as a remote
    // workspace, where resume permission overrides are rejected. Let Codex discover
    // its local daemon and assert YOLO through the dedicated supported flag instead.
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("--remote", `unix://${daemon.socketPath}`);
  }
  args.push("-C", cwd, "-c", 'tui.terminal_title=["thread-id"]');
  return { command: "codex", args, cwd };
}
