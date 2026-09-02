import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { MANAGED_DEVELOPER_INSTRUCTIONS } from "./peer-protocol.mjs";

export const CLAUDE_PEER_PLUGIN_PATH = fileURLToPath(new URL("../integrations/claude-peer", import.meta.url));

function launchError(code, message, options) {
  return Object.assign(new Error(message, options), { code });
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export class NativeSessionLauncher {
  #codexSocketPath;
  #env;
  #spawnProcess;
  #claudePluginPath;

  constructor({
    codexSocketPath,
    claudePluginPath = CLAUDE_PEER_PLUGIN_PATH,
    env = process.env,
    spawnProcess = spawn,
  } = {}) {
    if (!nonEmpty(codexSocketPath)) throw new TypeError("NativeSessionLauncher requires a Codex socket path");
    if (!nonEmpty(claudePluginPath) || !path.isAbsolute(claudePluginPath)) {
      throw new TypeError("NativeSessionLauncher requires an absolute Claude peer plugin path");
    }
    if (typeof spawnProcess !== "function") throw new TypeError("NativeSessionLauncher requires a process adapter");
    this.#codexSocketPath = codexSocketPath;
    this.#env = env;
    this.#spawnProcess = spawnProcess;
    this.#claudePluginPath = claudePluginPath;
  }

  async launch({ action, provider, cwd, session } = {}) {
    const targetProvider = session?.provider ?? provider;
    const targetCwd = session?.cwd ?? cwd;
    if (!nonEmpty(targetCwd)) {
      throw launchError("NATIVE_SESSION_INVALID", "native TUI를 실행할 workspace가 필요합니다");
    }

    let command;
    let args;
    if (action === "open" && targetProvider === "codex" && nonEmpty(session?.threadId)) {
      command = "codex";
      args = ["--remote", `unix://${this.#codexSocketPath}`, "-C", targetCwd, "resume", session.threadId];
    } else if (action === "open" && targetProvider === "claude" && nonEmpty(session?.threadId)) {
      command = "claude";
      args = ["attach", session.threadId];
    } else if (action === "new" && targetProvider === "codex") {
      command = "codex";
      args = [
        "--remote",
        `unix://${this.#codexSocketPath}`,
        "-C",
        targetCwd,
        "-c",
        `developer_instructions=${JSON.stringify(MANAGED_DEVELOPER_INSTRUCTIONS)}`,
      ];
    } else if (action === "new" && targetProvider === "claude") {
      command = "claude";
      args = [
        "agents",
        "--cwd",
        targetCwd,
        "--plugin-dir",
        this.#claudePluginPath,
        "--agent",
        "waga-session",
      ];
    } else {
      throw launchError("NATIVE_SESSION_INVALID", `지원하지 않는 native TUI 대상입니다: ${action ?? "unknown"}/${targetProvider ?? "unknown"}`);
    }

    const child = this.#spawnProcess(command, args, {
      cwd: targetCwd,
      env: this.#env,
      stdio: "inherit",
    });
    return new Promise((resolve, reject) => {
      child.once("error", (cause) => reject(launchError(
        "NATIVE_SESSION_START_FAILED",
        `${targetProvider} native TUI를 시작하지 못했습니다: ${cause.message}`,
        { cause },
      )));
      child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
    });
  }
}
