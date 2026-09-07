import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { EventLog } from "./event-log.mjs";
import { nativeAgentsCommand } from "./native-launcher.mjs";
import { retainedClaudeViewMatches } from "./providers/claude-view.mjs";
import { retainedCodexViewMatches } from "./providers/codex-view.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_SOCKET = `waga-${typeof process.getuid === "function" ? process.getuid() : "user"}`;
const CLI_PATH = fileURLToPath(new URL("./cli.mjs", import.meta.url));
const SESSION_HOST_PATH = fileURLToPath(new URL("./native-session-host.mjs", import.meta.url));
const SOURCE_DIR = fileURLToPath(new URL(".", import.meta.url));
const CURRENT_WINDOW_FORMAT = "#[bold,fg=#0f172a,bg=#38bdf8] #{?#{==:#{window_name},overview},OVERVIEW,#{window_name}} ";
const EXIT_COMMAND = "printf '%s\\n' 'Waga frontend를 종료했습니다. Claude/Codex 세션과 로그는 유지됩니다.'";
const VIEW_SETTLE_POLL_MS = 40;
const VIEW_SETTLE_MAX_POLLS = 50;
const VIEW_SETTLE_STABLE_POLLS = 6;
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
    const result = await execFileAsync("tmux", args, { env, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5_000, killSignal: "SIGKILL" });
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

function defaultWait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
    const [windowId, sessionId = "", paneDead = "0"] = line.split("\t");
    return { windowId, sessionId, paneDead: paneDead === "1" };
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
  #sessionHostPath;
  #eventLog;
  #wait;
  #claudeViewMatches;

  constructor({ run = defaultRun, launch = defaultLaunch, env = process.env, cliPath = CLI_PATH, nodePath = process.execPath, socketName = DEFAULT_SOCKET, revision = CURRENT_REVISION, sessionHostPath = SESSION_HOST_PATH, eventLog = new EventLog(), wait = defaultWait, claudeViewMatches = retainedClaudeViewMatches } = {}) {
    this.#run = run;
    this.#launch = launch;
    this.#env = env;
    this.#cliPath = cliPath;
    this.#nodePath = nodePath;
    this.#socketName = socketName;
    this.#revision = revision;
    this.#sessionHostPath = sessionHostPath;
    this.#eventLog = eventLog;
    this.#wait = wait;
    this.#claudeViewMatches = claudeViewMatches;
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

  async focusOrOpen(session, commandSpec, { force = false, knownNativeIds = [] } = {}) {
    const sessionName = this.#env.WAGA_TMUX_SESSION || (await this.#call(["display-message", "-p", "#{session_name}"])).stdout.trim();
    if (!sessionName) throw Object.assign(new Error("Waga tmux session is unavailable"), { code: "TMUX_SESSION_UNAVAILABLE" });
    const listed = await this.#call(["list-windows", "-t", sessionName, "-F", "#{window_id}\t#{@waga_session_id}\t#{pane_dead}"]);
    const existing = parseWindows(listed.stdout).find((entry) => entry.sessionId === session.id);
    let changedView = false;
    if (existing && !existing.paneDead && !force && (session.provider ?? session.id.split(":", 1)[0]) === "claude") {
      const pane = await this.#call(["display-message", "-p", "-t", existing.windowId, "#{pane_pid}"], { check: false });
      changedView = pane.code !== 0 || !await this.#claudeViewMatches(pane.stdout.trim(), commandSpec);
    }
    if (existing && !existing.paneDead && !force && (session.provider ?? session.id.split(":", 1)[0]) === "codex") {
      const title = await this.#call(["display-message", "-p", "-t", existing.windowId, "#{pane_title}"], { check: false });
      const frame = await this.#call(["capture-pane", "-p", "-t", existing.windowId, "-S", "0", "-E", "1"], { check: false });
      changedView = title.code !== 0 || frame.code !== 0
        || !retainedCodexViewMatches(session.nativeId, title.stdout, frame.stdout, knownNativeIds);
    }
    if (existing && !existing.paneDead && !force && !changedView) {
      await this.#setSessionWindowMetadata(existing.windowId, session, commandSpec);
      await this.#call(["select-window", "-t", existing.windowId]);
      return { reused: true, windowId: existing.windowId };
    }
    if (existing) {
      const reason = force ? "forced_reattach" : changedView ? "native_view_changed" : "dead_view";
      this.#eventLog.record("session_view_respawn_requested", { sessionId: session.id, windowId: existing.windowId, reason });
      await this.#call([
        "respawn-window", "-k", "-t", existing.windowId, "-c", commandSpec.cwd,
        this.#sessionCommand(session, commandSpec),
      ]);
      await this.#setSessionWindowMetadata(existing.windowId, session, commandSpec);
      this.#eventLog.record("session_view_respawned", { sessionId: session.id, windowId: existing.windowId, reason });
      await this.#waitForSettledFrame(existing.windowId);
      await this.#call(["select-window", "-t", existing.windowId]);
      return { reused: true, windowId: existing.windowId };
    }

    this.#eventLog.record("session_view_open_requested", { sessionId: session.id, reason: "dock_open" });
    const created = await this.#call([
      "new-window", "-d", "-P", "-F", "#{window_id}", "-t", sessionName,
      "-n", safeWindowName(session), "-c", commandSpec.cwd,
      this.#sessionCommand(session, commandSpec),
    ]);
    const windowId = created.stdout.trim();
    if (!/^@[0-9]+$/.test(windowId)) throw Object.assign(new Error("tmux did not return the native session window id"), { code: "TMUX_WINDOW_FAILED" });
    try {
      await this.#call(["set-window-option", "-t", windowId, "@waga_session_id", session.id]);
      await this.#setSessionWindowMetadata(windowId, session, commandSpec);
      await this.#call(["set-window-option", "-t", windowId, "automatic-rename", "off"]);
      await this.#styleWindow([], windowId);
      this.#eventLog.record("session_view_opened", { sessionId: session.id, windowId, reason: "dock_open" });
      await this.#call(["select-window", "-t", windowId]);
    } catch (error) {
      // Only this invocation's newly created frontend may be rolled back.
      try { await this.#call(["kill-window", "-t", windowId]); } catch {}
      throw error;
    }
    return { reused: false, windowId };
  }

  async focusAgentsViewFromWindow(windowId) {
    if (!/^@[0-9]+$/.test(windowId)) {
      throw Object.assign(new Error(`Invalid tmux window id: ${windowId}`), { code: "TMUX_WINDOW_INVALID" });
    }
    const providerResult = await this.#call(["show-options", "-w", "-v", "-t", windowId, "@waga_provider"], { check: false });
    const provider = providerResult.stdout.trim();
    if (!["claude", "codex"].includes(provider)) return { code: 0, ignored: true };
    const cwdResult = await this.#call(["show-options", "-w", "-v", "-t", windowId, "@waga_project_cwd"], { check: false });
    const cwd = cwdResult.stdout.trim();
    if (!cwd) throw Object.assign(new Error(`Waga session window is missing its project cwd: ${windowId}`), { code: "TMUX_WINDOW_INVALID" });
    const sessionResult = await this.#call(["display-message", "-p", "-t", windowId, "#{session_name}"]);
    const sessionName = sessionResult.stdout.trim();
    const commandSpec = nativeAgentsCommand(provider, { cwd });
    const listed = await this.#call(["list-windows", "-t", sessionName, "-F", "#{window_id}\t#{@waga_agents_provider}\t#{pane_dead}"]);
    const existing = parseWindows(listed.stdout).find((entry) => entry.sessionId === provider);
    if (existing && !existing.paneDead) {
      await this.#call(["select-window", "-t", existing.windowId]);
      return { reused: true, windowId: existing.windowId };
    }

    let agentsWindowId = existing?.windowId;
    if (agentsWindowId) {
      await this.#call(["respawn-window", "-k", "-t", agentsWindowId, "-c", commandSpec.cwd, shellCommand(commandSpec.command, commandSpec.args)]);
    } else {
      const created = await this.#call([
        "new-window", "-d", "-P", "-F", "#{window_id}", "-t", sessionName,
        "-n", `${provider === "claude" ? "Claude" : "Codex"} Agents`, "-c", commandSpec.cwd,
        shellCommand(commandSpec.command, commandSpec.args),
      ]);
      agentsWindowId = created.stdout.trim();
      if (!agentsWindowId) throw Object.assign(new Error("tmux did not return the Agents view window id"), { code: "TMUX_WINDOW_FAILED" });
    }
    await this.#call(["set-window-option", "-t", agentsWindowId, "@waga_agents_provider", provider]);
    await this.#call(["set-window-option", "-t", agentsWindowId, "@waga_provider", provider]);
    await this.#call(["set-window-option", "-t", agentsWindowId, "@waga_project_cwd", commandSpec.cwd]);
    await this.#call(["set-window-option", "-t", agentsWindowId, "automatic-rename", "off"]);
    await this.#styleWindow([], agentsWindowId);
    await this.#call(["select-window", "-t", agentsWindowId]);
    return { reused: false, windowId: agentsWindowId };
  }

  async closeSessionView(session) {
    const sessionName = this.#env.WAGA_TMUX_SESSION || (await this.#call(["display-message", "-p", "#{session_name}"])).stdout.trim();
    if (!sessionName) throw Object.assign(new Error("Waga tmux session is unavailable"), { code: "TMUX_SESSION_UNAVAILABLE" });
    const listed = await this.#call(["list-windows", "-t", sessionName, "-F", "#{window_id}\t#{@waga_session_id}"]);
    const existing = parseWindows(listed.stdout).find((entry) => entry.sessionId === session.id);
    if (!existing) return { closed: false };
    this.#eventLog.record("session_view_close_requested", { sessionId: session.id, windowId: existing.windowId, reason: "session_archived" });
    await this.#call(["kill-window", "-t", existing.windowId]);
    this.#eventLog.record("session_view_closed", { sessionId: session.id, windowId: existing.windowId, reason: "session_archived" });
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
    for (const entry of stale) {
      const details = { sessionId: entry.sessionId, windowId: entry.windowId, reason: "provider_missing_from_loaded_set" };
      this.#eventLog.record("session_view_close_requested", details);
      await this.#call(["kill-window", "-t", entry.windowId]);
      this.#eventLog.record("session_view_closed", details);
    }
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
    this.#eventLog.record("dock_shutdown_requested", { tmuxSession: sessionName, reason: "user_leave" });
    if (this.#env.WAGA_TMUX_MODE === "existing") {
      const switched = await this.#call(["switch-client", "-l"], { check: false });
      if (switched.code !== 0) await this.#call(["detach-client", "-E", EXIT_COMMAND], { check: false });
    } else {
      await this.#call(["detach-client", "-E", EXIT_COMMAND], { check: false });
    }
    await this.#call(["kill-session", "-t", sessionName]);
    return { closeOverview: true };
  }

  async #currentSessionName() {
    const sessionName = this.#env.WAGA_TMUX_SESSION || (await this.#call(["display-message", "-p", "#{session_name}"])).stdout.trim();
    if (!sessionName) throw Object.assign(new Error("Waga tmux session is unavailable"), { code: "TMUX_SESSION_UNAVAILABLE" });
    return sessionName;
  }

  #sessionCommand(session, commandSpec) {
    const provider = session.provider ?? String(session.id).split(":", 1)[0];
    return shellCommand(this.#nodePath, [
      this.#sessionHostPath,
      provider,
      session.id,
      "--",
      commandSpec.command,
      ...commandSpec.args,
    ]);
  }

  async #setSessionWindowMetadata(windowId, session, commandSpec) {
    const provider = session.provider ?? String(session.id).split(":", 1)[0];
    const projectCwd = path.resolve(session.projectCwd ?? commandSpec.cwd);
    await this.#call(["set-window-option", "-t", windowId, "@waga_provider", provider]);
    await this.#call(["set-window-option", "-t", windowId, "@waga_project_cwd", projectCwd]);
  }

  async #waitForSettledFrame(windowId) {
    let previous = null;
    let stablePolls = 0;
    for (let attempt = 0; attempt < VIEW_SETTLE_MAX_POLLS; attempt += 1) {
      const captured = await this.#call(["capture-pane", "-p", "-t", windowId], { check: false });
      const frame = captured.code === 0 ? captured.stdout.trim() : "";
      if (frame && frame === previous) stablePolls += 1;
      else stablePolls = frame ? 1 : 0;
      previous = frame;
      if (stablePolls >= VIEW_SETTLE_STABLE_POLLS) return true;
      await this.#wait(VIEW_SETTLE_POLL_MS);
    }
    return false;
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
        ? "#{?#{==:#{window_name},overview},,#[bold,fg=#4ade80]Alt+A agents · Alt+G dock }"
        : "#{?#{==:#{window_name},overview},,#[bold,fg=#4ade80]prefix+0  overview }"],
      ["status-right-length", "36"],
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
      await this.#call([...prefix, "bind-key", "-n", "M-g", "select-window -t :overview ; send-keys -t :overview M-r"]);
      const agentsViewCommand = shellCommand(this.#nodePath, [this.#cliPath, "tmux-agents-view", "#{window_id}"]);
      await this.#call([...prefix, "bind-key", "-n", "M-a", "run-shell", "-b", agentsViewCommand]);
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
