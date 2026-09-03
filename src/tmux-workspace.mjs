import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_SOCKET = `waga-${typeof process.getuid === "function" ? process.getuid() : "user"}`;
const CLI_PATH = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const CURRENT_WINDOW_FORMAT = "#[bold,fg=colour234,bg=colour117] #{?#{==:#{window_name},overview},OVERVIEW,#{window_name}} ";
export const GLOBAL_DOCK_SESSION = "waga-global";

function cleanResult(error) {
  return {
    stdout: String(error.stdout ?? ""),
    stderr: String(error.stderr ?? error.message ?? ""),
    code: Number.isInteger(error.code) ? error.code : error.code === "ENOENT" ? 127 : 1,
  };
}

async function defaultRun(args, { env = process.env } = {}) {
  try {
    const result = await execFileAsync("tmux", args, { env, encoding: "utf8", maxBuffer: 1024 * 1024 });
    return { ...result, code: 0 };
  } catch (error) {
    if (Number.isInteger(error.code) || error.code === "ENOENT") return cleanResult(error);
    throw error;
  }
}

function defaultLaunch(args, { env = process.env, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("tmux", args, { env, ...options });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal }));
  });
}

function quote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function shellCommand(command, args = []) {
  return `exec ${[command, ...args].map(quote).join(" ")}`;
}

export function workspaceSessionName(cwd) {
  const resolved = path.resolve(cwd);
  const readable = path.basename(resolved).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "workspace";
  const digest = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return `waga-${readable}-${digest}`;
}

function safeWindowName(session) {
  const provider = session.provider === "claude" ? "Claude" : "Codex";
  const name = String(session.name ?? session.nativeId ?? "session")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 28);
  return `${provider} · ${name || "session"}`;
}

function parseWindows(stdout) {
  return String(stdout).split("\n").filter(Boolean).map((line) => {
    const [windowId, sessionId = ""] = line.split("\t");
    return { windowId, sessionId };
  });
}

export class TmuxWorkspace {
  #run;
  #launch;
  #env;
  #cliPath;
  #nodePath;
  #socketName;

  constructor({ run = defaultRun, launch = defaultLaunch, env = process.env, cliPath = CLI_PATH, nodePath = process.execPath, socketName = DEFAULT_SOCKET } = {}) {
    this.#run = run;
    this.#launch = launch;
    this.#env = env;
    this.#cliPath = cliPath;
    this.#nodePath = nodePath;
    this.#socketName = socketName;
  }

  async enter({ cwd = process.cwd(), filterCwd = null } = {}) {
    const workspace = path.resolve(cwd);
    const filter = filterCwd ? path.resolve(filterCwd) : null;
    const sessionName = filter ? workspaceSessionName(filter) : GLOBAL_DOCK_SESSION;
    const insideTmux = Boolean(this.#env.TMUX);
    const mode = insideTmux ? "existing" : "isolated";
    const prefix = insideTmux ? [] : ["-L", this.#socketName, "-f", "/dev/null"];

    const version = await this.#call([...prefix, "-V"], { check: false });
    if (version.code !== 0) {
      throw Object.assign(new Error("tmux is required for the interactive dock; use `waga list` for text output"), { code: "TMUX_UNAVAILABLE" });
    }

    if (insideTmux) {
      const current = (await this.#call(["display-message", "-p", "#{session_name}"])).stdout.trim();
      if (current === sessionName) {
        await this.#call(["select-window", "-t", ":overview"]);
        return { code: 0, mode };
      }
    }

    const exists = await this.#call([...prefix, "has-session", "-t", sessionName], { check: false });
    const commandArgs = [
      `WAGA_TMUX_MODE=${mode}`,
      `WAGA_TMUX_SESSION=${sessionName}`,
      this.#nodePath,
      this.#cliPath,
      "overview",
    ];
    if (filter) commandArgs.push("--cwd", filter);
    const command = shellCommand("env", commandArgs);
    if (exists.code !== 0) {
      await this.#call([...prefix, "new-session", "-d", "-s", sessionName, "-n", "overview", "-c", workspace, command]);
    } else {
      const windows = await this.#call([...prefix, "list-windows", "-t", sessionName, "-F", "#{window_name}"]);
      if (!windows.stdout.split("\n").includes("overview")) {
        await this.#call([...prefix, "new-window", "-d", "-t", sessionName, "-n", "overview", "-c", workspace, command]);
      }
    }
    await this.#configure(prefix, sessionName, mode);

    if (insideTmux) {
      await this.#call(["switch-client", "-t", sessionName]);
      return { code: 0, mode };
    }
    const result = await this.#launch([...prefix, "attach-session", "-t", sessionName], { env: this.#env, stdio: "inherit" });
    return { code: result.code, mode };
  }

  async focusOrOpen(session, commandSpec) {
    const sessionName = this.#env.WAGA_TMUX_SESSION || (await this.#call(["display-message", "-p", "#{session_name}"])).stdout.trim();
    if (!sessionName) throw Object.assign(new Error("Waga tmux session is unavailable"), { code: "TMUX_SESSION_UNAVAILABLE" });
    const listed = await this.#call(["list-windows", "-t", sessionName, "-F", "#{window_id}\t#{@waga_session_id}"]);
    const existing = parseWindows(listed.stdout).find((entry) => entry.sessionId === session.id);
    if (existing) {
      await this.#call(["select-window", "-t", existing.windowId]);
      return { reused: true, windowId: existing.windowId };
    }

    const created = await this.#call([
      "new-window", "-d", "-P", "-F", "#{window_id}", "-t", sessionName,
      "-n", safeWindowName(session), "-c", commandSpec.cwd,
      shellCommand(commandSpec.command, commandSpec.args),
    ]);
    const windowId = created.stdout.trim();
    if (!windowId) throw Object.assign(new Error("tmux did not return the native session window id"), { code: "TMUX_WINDOW_FAILED" });
    await this.#call(["set-window-option", "-t", windowId, "@waga_session_id", session.id]);
    await this.#call(["set-window-option", "-t", windowId, "automatic-rename", "off"]);
    await this.#styleWindow([], windowId);
    await this.#call(["select-window", "-t", windowId]);
    return { reused: false, windowId };
  }

  async leave() {
    if (this.#env.WAGA_TMUX_MODE === "existing") await this.#call(["switch-client", "-l"]);
    else await this.#call(["detach-client"]);
  }

  async #configure(prefix, sessionName, mode) {
    const options = [
      ["status", "on"],
      ["status-position", "top"],
      ["status-interval", "1"],
      ["status-style", "bg=colour234,fg=colour250"],
      ["status-left", "#[bold,fg=colour117] Waga #[default]│ "],
      ["status-left-length", "20"],
      ["status-right", mode === "isolated"
        ? "#{?#{==:#{window_name},overview},,#[fg=colour114]Alt+G  overview }"
        : "#{?#{==:#{window_name},overview},,#[fg=colour114]prefix+0  overview }"],
      ["status-right-length", "24"],
      ["base-index", "0"],
      ["renumber-windows", "on"],
    ];
    for (const [name, value] of options) await this.#call([...prefix, "set-option", "-t", sessionName, name, value]);
    await this.#call([...prefix, "move-window", "-r", "-t", sessionName]);
    await this.#call([...prefix, "set-window-option", "-t", `${sessionName}:overview`, "automatic-rename", "off"]);
    const windows = await this.#call([...prefix, "list-windows", "-t", sessionName, "-F", "#{window_id}"]);
    for (const windowId of windows.stdout.split("\n").filter(Boolean)) await this.#styleWindow(prefix, windowId);
    if (mode === "isolated") {
      await this.#call([...prefix, "set-option", "-g", "default-terminal", "tmux-256color"]);
      await this.#call([...prefix, "set-option", "-as", "terminal-features", ",*:RGB:extkeys"]);
      await this.#call([...prefix, "set-option", "-s", "extended-keys", "on"]);
      await this.#call([...prefix, "set-option", "-s", "escape-time", "0"]);
      await this.#call([...prefix, "bind-key", "-n", "M-g", "select-window", "-t", ":overview"]);
      await this.#call([...prefix, "bind-key", "-n", "S-Enter", "send-keys", "C-j"]);
    }
  }

  async #styleWindow(prefix, windowId) {
    await this.#call([...prefix, "set-window-option", "-t", windowId, "window-status-format", ""]);
    await this.#call([...prefix, "set-window-option", "-t", windowId, "window-status-current-format", CURRENT_WINDOW_FORMAT]);
  }

  async #call(args, { check = true } = {}) {
    const result = await this.#run(args, { env: this.#env });
    if (check && result.code !== 0) {
      throw Object.assign(new Error(result.stderr.trim() || `tmux ${args[0]} failed with exit code ${result.code}`), { code: "TMUX_COMMAND_FAILED" });
    }
    return result;
  }
}

export async function enterWagaDock({ cwd = process.cwd(), filterCwd = null, workspace = new TmuxWorkspace() } = {}) {
  return workspace.enter({ cwd, filterCwd });
}
