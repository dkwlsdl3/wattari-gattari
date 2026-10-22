import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { claudeInteractivePid, claudeInteractiveRegistryMatches, retainedClaudeViewMatches } from "./claude-view.mjs";

const exec = promisify(execFile);
const host = fileURLToPath(new URL("../native-session-host.mjs", import.meta.url));
export const interactiveRetainedName = id => `waga-retained-${crypto.createHash("sha256").update(id).digest("hex")}`;
export function interactiveUnavailable() {
  return Object.assign(new Error("Claude interactive terminal is unmanaged or has exited; Waga cannot attach, restart or archive it"), { code: "CLAUDE_INTERACTIVE_UNAVAILABLE" });
}

export class ClaudeInteractive {
  constructor({ run = (args, options) => exec("tmux", args, { ...options, encoding: "utf8", timeout: 5000 }), env = process.env } = {}) {
    this.run = run;
    this.env = env;
    this.prefix = env.TMUX ? [] : ["-L", `waga-${typeof process.getuid === "function" ? process.getuid() : "user"}`, "-f", "/dev/null"];
  }

  async verify(session) {
    try {
      const { stdout } = await this.run([...this.prefix, "list-panes", "-t", interactiveRetainedName(session.id),
        "-F", "#{pane_pid}\t#{pane_dead}\t#{@waga_session_id}\t#{@waga_interactive}"], { env: this.env });
      const rows = stdout.trimEnd().split("\n");
      const [pid, dead, id, managed] = rows[0].split("\t");
      if (rows.length !== 1 || dead !== "0" || id !== session.id || managed !== "1"
        || !await retainedClaudeViewMatches(pid, { reuseOnly: true, interactivePid: session.pid, interactiveId: session.id }, { env: this.env })) throw interactiveUnavailable();
    } catch { throw interactiveUnavailable(); }
  }

  // Kill the verified window, including all links and legacy remain-on-exit panes.
  async terminate(session) {
    await this.verify(session);
    await this.run([...this.prefix, "kill-window", "-t", interactiveRetainedName(session.id)], { env: this.env });
  }

  async list() {
    // Claude does not publish an agents row until startup trust/import prompts
    // finish. Discover our terminals too so those prompts remain reachable.
    let stdout;
    try { ({ stdout } = await this.run([...this.prefix, "list-panes", "-a", "-F",
      "#{session_name}\t#{window_id}\t#{pane_pid}\t#{pane_dead}\t#{@waga_session_id}\t#{@waga_interactive}"], { env: this.env })); }
    catch { return []; }
    const sessions = new Map();
    for (const line of stdout.trimEnd().split("\n")) {
      const [name, window, hostPid, dead, id, managed] = line.split("\t");
      if (managed !== "1" || dead !== "0" || !/^claude:[0-9a-f-]{36}$/i.test(id)
        || name !== interactiveRetainedName(id) || !/^@[0-9]+$/.test(window)) continue;
      const pid = await claudeInteractivePid(hostPid);
      if (!pid || !await claudeInteractiveRegistryMatches(id, pid, this.env)) continue;
      try {
        const result = await this.run([...this.prefix, "show-options", "-w", "-v", "-t", window, "@waga_project_cwd"], { env: this.env });
        const cwd = result.stdout.replace(/\n$/, "");
        if (!cwd.startsWith("/")) continue;
        sessions.set(id, { id, sessionId: id.slice(7), nativeId: id.slice(7), provider: "claude", kind: "interactive", pid,
          cwd, projectCwd: cwd, name: "Claude CLI 시작", status: "needs-input", updatedAt: 0 });
      } catch { /* A concurrently closed terminal is no longer discoverable. */ }
    }
    return [...sessions.values()];
  }

  async create(args, cwd, sessionId = crypto.randomUUID()) {
    const id = `claude:${sessionId}`, retained = interactiveRetainedName(id);
    // tmux executes multiple command arguments directly. The prompt is passed in
    // a per-pane environment value, never interpolated into a shell command.
    try { await this.run([...this.prefix, "new-session", "-d", "-s", retained, "-x", "120", "-y", "40", "-c", cwd,
      "-e", "WAGA_WAIT_FOR_VISIBLE=0",
      ...(!this.env.TMUX || this.env.WAGA_TMUX_MODE === "isolated" ? ["-e", "CLAUDE_CODE_TMUX_TRUECOLOR=1"] : []),
      "-e", `WAGA_CLAUDE_LAUNCH=${JSON.stringify(["--session-id", sessionId, ...args])}`,
      process.execPath, host, "claude", id, "--", "claude",
      ";", "set-window-option", "-t", retained, "@waga_session_id", id,
      ";", "set-window-option", "-t", retained, "@waga_provider", "claude",
      ";", "set-window-option", "-t", retained, "@waga_interactive", "1",
      ";", "set-window-option", "-t", retained, "@waga_project_cwd", cwd,
      ";", "set-window-option", "-t", retained, "remain-on-exit", "off"], { env: this.env });
    } catch (error) {
      // A timed-out tmux request may already have launched Claude. Preserve its
      // UUID without retrying, terminating it, or reporting confirmed creation.
      if (!error.killed && error.code !== "ETIMEDOUT") throw error;
      throw Object.assign(new Error(`Claude 생성 여부를 확인하지 못했습니다 (${id}). 목록을 확인하고 중복 생성하지 마세요.`, { cause: error }), {
        code: "CLAUDE_CREATION_UNCONFIRMED", nativeId: sessionId,
      });
    }
    return { provider: "claude", nativeId: sessionId, sessionId, kind: "interactive" };
  }
}
