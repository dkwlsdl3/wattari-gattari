import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_SOCKET = `waga-${typeof process.getuid === "function" ? process.getuid() : "user"}`;
const CLI_PATH = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const SOURCE_DIR = fileURLToPath(new URL(".", import.meta.url));
const CURRENT_WINDOW_FORMAT = "#[bold,fg=#0f172a,bg=#38bdf8] #{?#{==:#{window_name},overview},OVERVIEW,#{window_name}} ";
export const GLOBAL_DOCK_SESSION = "waga-global";

function sourceFiles(directory, root = directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(absolute, root));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push({ absolute, relative: path.relative(root, absolute) });
  }
  return files;
}

export function sourceRevision(directory = SOURCE_DIR) {
  const hash = crypto.createHash("sha256");
  for (const file of sourceFiles(directory)) {
    hash.update(file.relative);
    hash.update("\0");
    hash.update(fs.readFileSync(file.absolute));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

const CURRENT_REVISION = sourceRevision();

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
  #revision;

  constructor({ run = defaultRun, launch = defaultLaunch, env = process.env, cliPath = CLI_PATH, nodePath = process.execPath, socketName = DEFAULT_SOCKET, revision = CURRENT_REVISION } = {}) {
    this.#run = run;
    this.#launch = launch;
    this.#env = env;
    this.#cliPath = cliPath;
    this.#nodePath = nodePath;
    this.#socketName = socketName;
    this.#revision = revision;
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

    const currentSession = insideTmux
      ? (await this.#call(["display-message", "-p", "#{session_name}"])).stdout.trim()
      : null;

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
    let replaceOverview = false;
    if (exists.code !== 0) {
      await this.#call([...prefix, "new-session", "-d", "-s", sessionName, "-n", "overview", "-c", workspace, command]);
      replaceOverview = true;
    } else {
      const windows = await this.#call([...prefix, "list-windows", "-t", sessionName, "-F", "#{window_name}\t#{@waga_revision}\t#{@waga_cwd}"]);
      const overview = windows.stdout.split("\n").find((line) => line.split("\t", 1)[0] === "overview");
      if (!overview) {
        await this.#call([...prefix, "new-window", "-d", "-t", sessionName, "-n", "overview", "-c", workspace, command]);
        replaceOverview = true;
      } else {
        const [, revision, launchCwd] = overview.split("\t");
        if (revision !== this.#revision || launchCwd !== workspace) {
          await this.#call([...prefix, "respawn-window", "-k", "-t", `${sessionName}:overview`, "-c", workspace, command]);
          replaceOverview = true;
        }
      }
    }
    if (replaceOverview) {
      await this.#call([...prefix, "set-window-option", "-t", `${sessionName}:overview`, "@waga_revision", this.#revision]);
      await this.#call([...prefix, "set-window-option", "-t", `${sessionName}:overview`, "@waga_cwd", workspace]);
    }
    if (replaceOverview) await this.#configure(prefix, sessionName, mode);

    if (insideTmux) {
      if (currentSession === sessionName) await this.#call(["select-window", "-t", `${sessionName}:overview`]);
      else await this.#call(["switch-client", "-t", sessionName]);
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
      await this.#call([
        "respawn-window", "-k", "-t", existing.windowId, "-c", commandSpec.cwd,
        shellCommand(commandSpec.command, commandSpec.args),
      ]);
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

  async closeSessionView(session) {
    const sessionName = this.#env.WAGA_TMUX_SESSION || (await this.#call(["display-message", "-p", "#{session_name}"])).stdout.trim();
    if (!sessionName) throw Object.assign(new Error("Waga tmux session is unavailable"), { code: "TMUX_SESSION_UNAVAILABLE" });
    const listed = await this.#call(["list-windows", "-t", sessionName, "-F", "#{window_id}\t#{@waga_session_id}"]);
    const existing = parseWindows(listed.stdout).find((entry) => entry.sessionId === session.id);
    if (!existing) return { closed: false };
    await this.#call(["kill-window", "-t", existing.windowId]);
    return { closed: true, windowId: existing.windowId };
  }

  async reconcileSessionViews(sessions, { availableProviders = [] } = {}) {
    const sessionName = await this.#currentSessionName();
    const activeIds = new Set(sessions.map((session) => session.id));
    const healthy = new Set(availableProviders);
    const listed = await this.#call(["list-windows", "-t", sessionName, "-F", "#{window_id}\t#{@waga_session_id}"]);
    const stale = parseWindows(listed.stdout).filter(({ sessionId }) => {
      const separator = sessionId.indexOf(":");
      const provider = separator > 0 ? sessionId.slice(0, separator) : null;
      return provider && healthy.has(provider) && !activeIds.has(sessionId);
    });
    for (const entry of stale) await this.#call(["kill-window", "-t", entry.windowId]);
    return { closed: stale.map((entry) => entry.sessionId) };
  }

  async shouldRefreshOverview() {
    const sessionName = await this.#currentSessionName();
    const result = await this.#call([
      "display-message", "-p", "-t", `${sessionName}:overview`,
      "#{window_active}\t#{session_attached}",
    ], { check: false });
    if (result.code !== 0) return true;
    const [active, attached] = result.stdout.trim().split("\t");
    return active === "1" && Number(attached) > 0;
  }

  async leave() {
    const sessionName = await this.#currentSessionName();
    if (this.#env.WAGA_TMUX_MODE === "existing") {
      const switched = await this.#call(["switch-client", "-l"], { check: false });
      if (switched.code !== 0) await this.#call(["detach-client"], { check: false });
    } else {
      await this.#call(["detach-client"], { check: false });
    }
    await this.#call(["kill-session", "-t", sessionName]);
    return { closeOverview: true };
  }

  async #currentSessionName() {
    const sessionName = this.#env.WAGA_TMUX_SESSION || (await this.#call(["display-message", "-p", "#{session_name}"])).stdout.trim();
    if (!sessionName) throw Object.assign(new Error("Waga tmux session is unavailable"), { code: "TMUX_SESSION_UNAVAILABLE" });
    return sessionName;
  }

  async #configure(prefix, sessionName, mode) {
    const options = [
      ["status", "on"],
      ["status-position", "top"],
      ["status-interval", "1"],
      ["status-style", "bg=#0f172a,fg=#e2e8f0"],
      ["status-left", "#[bold,fg=#38bdf8] Waga #[default]│ "],
      ["status-left-length", "20"],
      ["status-right", mode === "isolated"
        ? "#{?#{==:#{window_name},overview},,#[bold,fg=#4ade80]Alt+G  dock }"
        : "#{?#{==:#{window_name},overview},,#[bold,fg=#4ade80]prefix+0  overview }"],
      ["status-right-length", "24"],
      ["base-index", "0"],
      ["renumber-windows", "on"],
      ["mouse", "on"],
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
