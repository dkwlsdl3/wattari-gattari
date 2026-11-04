import { execFile, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { EventLog } from "./event-log.mjs";
import { nativeAgentsCommand } from "./native-launcher.mjs";
import { retainedClaudeViewMatches } from "./providers/claude-view.mjs";
import { retainedCodexViewState } from "./providers/codex-view.mjs";
import { interactiveUnavailable } from "./providers/claude-interactive.mjs";
import { quote, shellCommand } from './shell-command.mjs';
export { shellCommand } from './shell-command.mjs';

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
const CODEX_ATTACH_TIMEOUT_MS = 30_000;
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

export function workspaceSessionName(cwd) {
  const resolved = path.resolve(cwd);
  const readable = path.basename(resolved).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "workspace";
  const digest = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return `waga-${readable}-${digest}`;
}

export function retainedSessionName(sessionId) {
  return `waga-retained-${crypto.createHash("sha256").update(sessionId).digest("hex")}`;
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

  async enter({ cwd = process.cwd(), filterCwd = null, hostsPath = null } = {}) {
    const workspace = path.resolve(cwd);
    const filter = filterCwd ? path.resolve(filterCwd) : null;
    const sessionName = `waga-view-${crypto.randomUUID()}`;
    const insideTmux = Boolean(this.#env.TMUX);
    const mode = insideTmux ? "existing" : "isolated";
    const prefix = insideTmux ? [] : ["-L", this.#socketName, "-f", "/dev/null"];

    const version = await this.#call([...prefix, "-V"], { check: false });
    if (version.code !== 0) {
      throw Object.assign(new Error("tmux is required for the interactive dock; use `waga list` for text output"), { code: "TMUX_UNAVAILABLE" });
    }

    const commandArgs = [
      `WAGA_TMUX_MODE=${mode}`,
      `WAGA_TMUX_SESSION=${sessionName}`,
      "WAGA_TMUX_INDEPENDENT=1",
      ...(this.#env.WAGA_REMOTE_HOST ? [`WAGA_REMOTE_HOST=${this.#env.WAGA_REMOTE_HOST}`] : []),
      ...(this.#env.WAGA_REMOTE_HOST_ID ? [`WAGA_REMOTE_HOST_ID=${this.#env.WAGA_REMOTE_HOST_ID}`] : []),
      this.#nodePath,
      this.#cliPath,
      "overview",
    ];
    if (filter) commandArgs.push("--cwd", filter);
    if (hostsPath) commandArgs.push("--hosts", hostsPath);
    const command = shellCommand("env", commandArgs);
    await this.#call([...prefix, "new-session", "-d", "-s", sessionName, "-n", "overview", "-c", workspace, command]);
    try {
      await this.#call([...prefix, "set-window-option", "-t", `${sessionName}:overview`, "@waga_revision", this.#revision]);
      await this.#call([...prefix, "set-window-option", "-t", `${sessionName}:overview`, "@waga_cwd", workspace]);
      await this.#configure(prefix, sessionName, mode);
      // A closed terminal only releases its private overview and window links.
      await this.#call([...prefix, "set-hook", "-t", sessionName, "client-detached",
        `if-shell -t ${sessionName}:overview -F '#{==:#{session_attached},0}' 'kill-session -t ${sessionName}'`]);
      if (insideTmux) {
        await this.#call(["switch-client", "-t", sessionName]);
        return { code: 0, mode };
      }
      const result = await this.#launch([...prefix, "attach-session", ...(this.#env.WAGA_REMOTE_HOST ? ["-f", "ignore-size"] : []), "-t", sessionName], { env: this.#env, stdio: "inherit" });
      await this.#call([...prefix, "kill-session", "-t", sessionName], { check: false });
      return { code: result.code, mode };
    } catch (error) {
      await this.#call([...prefix, "kill-session", "-t", sessionName], { check: false });
      throw error;
    }
  }

  async openRemoteHost(host, commandSpec) {
    const sessionName = await this.#currentSessionName();
    const windows = await this.#call(["list-windows", "-t", sessionName, "-F", "#{window_id}\t#{@waga_remote_host}\t#{pane_dead}"]);
    const existing = parseWindows(windows.stdout).find(window => window.sessionId === host.id);
    if (existing && !existing.paneDead) {
      await this.#call(["select-window", "-t", existing.windowId]);
      return { windowId: existing.windowId, reused: true };
    }
    if (existing) await this.#call(["kill-window", "-t", existing.windowId]);
    // One tmux command queue installs the exit policy before SSH can exit.
    // new-window selects the new window, so sessionName targets it throughout.
    const created = await this.#call(["new-window", "-P", "-F", "#{window_id}", "-t", sessionName,
      "-n", `PC ${host.name}`, shellCommand(commandSpec.command, commandSpec.args),
      ";", "set-window-option", "-t", sessionName, "@waga_remote_host", host.id,
      ";", "set-window-option", "-t", sessionName, "remain-on-exit", "failed",
      ";", "set-window-option", "-t", sessionName, "automatic-rename", "off",
      ";", "set-hook", "-w", "-t", sessionName, "pane-exited", `if-shell -F '#{==:#{pane_dead_status},0}' 'select-window -t ${sessionName}:overview'`,
    ], { check: false });
    const windowId = created.stdout.trim();
    if (!/^@[0-9]+$/.test(windowId)) throw Object.assign(new Error("tmux did not return remote window ID"), { code: "TMUX_WINDOW_FAILED" });
    if (created.code !== 0) {
      await this.#call(["kill-window", "-t", windowId], { check: false });
      throw Object.assign(new Error(created.stderr.trim() || "Cannot configure remote window"), { code: "TMUX_COMMAND_FAILED" });
    }
    return { windowId };
  }

  async dockReleases() {
    const prefix = this.#env.TMUX ? [] : ['-L', this.#socketName, '-f', '/dev/null'];
    const result = await this.#call([...prefix, 'list-windows', '-a', '-F', '#{window_name}\t#{@waga_revision}\t#{@waga_release}'], { check: false });
    if (result.code !== 0) return [];
    return result.stdout.trimEnd().split('\n').flatMap(line => {
      const [name, source, revision] = line.split('\t');
      return name === 'overview' && source ? [{ revision: revision || null }] : [];
    });
  }

  async prepareOverviewRelease(revision) {
    const session = await this.#currentSessionName();
    if (this.#env.WAGA_RELOAD === '1') {
      await this.#configure([], session, this.#env.WAGA_TMUX_MODE);
      await this.#call(['set-window-option', '-t', `${session}:overview`, '@waga_revision', this.#revision]);
    }
    await this.#call(['set-window-option', '-t', `${session}:overview`, '@waga_release', revision]);
  }

  async reloadOverview(release, { hostsPath, filterCwd } = {}) {
    const session = await this.#currentSessionName(), target = `${session}:overview`;
    const pane = await this.#call(['display-message', '-p', '-t', target, '#{pane_pid}']);
    if (pane.stdout.trim() !== String(process.pid)) throw Error('Dock reload ownership does not match this process');
    const args = ['WAGA_RELOAD=1', `WAGA_TMUX_SESSION=${session}`, `WAGA_TMUX_MODE=${this.#env.WAGA_TMUX_MODE}`, 'WAGA_TMUX_INDEPENDENT=1',
      ...['WAGA_REMOTE_HOST', 'WAGA_REMOTE_HOST_ID'].filter(key => this.#env[key]).map(key => `${key}=${this.#env[key]}`),
      path.join(release.root, 'waga'), 'overview'];
    if (hostsPath) args.push('--hosts', hostsPath);
    if (filterCwd) args.push('--cwd', filterCwd);
    const command = `respawn-pane -k -t ${quote(target)} -c ${quote(process.cwd())} ${quote(shellCommand('env', args))}`;
    const condition = `#{&&:#{==:#{pane_pid},${process.pid}},#{&&:#{window_active},#{>:#{window_active_clients},0}}}`;
    const result = await this.#call(['if-shell', '-t', target, '-F', condition, command, 'display-message -p deferred']);
    return { deferred: result.stdout.trim() === 'deferred' };
  }

  async focusOrOpen(session, commandSpec, { force = false, knownNativeIds = [] } = {}) {
    const sessionName = this.#env.WAGA_TMUX_SESSION || (await this.#call(["display-message", "-p", "#{session_name}"])).stdout.trim();
    if (!sessionName) throw Object.assign(new Error("Waga tmux session is unavailable"), { code: "TMUX_SESSION_UNAVAILABLE" });
    const shared = commandSpec.reuseOnly || this.#env.WAGA_TMUX_INDEPENDENT === "1";
    const storageName = shared ? retainedSessionName(session.id) : sessionName;
    const listed = await this.#call(["list-windows", "-t", storageName, "-F", "#{window_id}\t#{@waga_session_id}\t#{pane_dead}"], { check: !shared });
    const existing = shared
      ? parseWindows(listed.code === 0 ? listed.stdout : "")[0]
      : parseWindows(listed.stdout).find((entry) => entry.sessionId === session.id);
    const select = (windowId) => this.#selectView(sessionName, windowId, shared);
    if (commandSpec.reuseOnly) {
      if (!existing || existing.paneDead || existing.sessionId !== session.id) throw interactiveUnavailable();
      const pane = await this.#call(["display-message", "-p", "-t", existing.windowId, "#{pane_pid}"], { check: false });
      if (pane.code !== 0 || !await this.#claudeViewMatches(pane.stdout.trim(), commandSpec)) throw interactiveUnavailable();
      await this.#setSessionWindowName(existing.windowId, session);
      await select(existing.windowId);
      return { reused: true, windowId: existing.windowId };
    }
    const stagedCodex = (session.provider ?? session.id.split(":", 1)[0]) === "codex"
      && typeof commandSpec.afterAttach === "function";
    const finish = async (windowId, launched) => {
      if (stagedCodex) {
        if (launched) await this.#waitForCodexAttach(windowId, session.nativeId);
        await commandSpec.afterAttach();
      }
      await select(windowId);
    };
    // Do not respawn a frontend being used by another terminal during navigation.
    const visible = shared && existing && !existing.paneDead
      ? await this.#call(["display-message", "-p", "-t", existing.windowId, "#{window_active_clients}"], { check: false }) : null;
    const inUse = visible && (visible.code !== 0 || Number(visible.stdout.trim()) > 0);
    const viewInUse = () => Object.assign(new Error("The shared frontend is visible in another terminal; return it to the dock before reattaching"), { code: "TMUX_VIEW_IN_USE" });
    if (inUse && force) throw viewInUse();
    if (shared && existing && !existing.paneDead && !force && existing.sessionId !== session.id) {
      // The winning creator may still be starting the frontend. Never spawn it twice.
      await finish(existing.windowId, true);
      return { reused: true, windowId: existing.windowId };
    }
    let changedView = false;
    if (existing && !existing.paneDead && !force && (session.provider ?? session.id.split(":", 1)[0]) === "claude") {
      const pane = await this.#call(["display-message", "-p", "-t", existing.windowId, "#{pane_pid}"], { check: false });
      changedView = pane.code !== 0 || !await this.#claudeViewMatches(pane.stdout.trim(), commandSpec);
    }
    if (existing && !existing.paneDead && !force && (session.provider ?? session.id.split(":", 1)[0]) === "codex") {
      const title = await this.#call(["display-message", "-p", "-t", existing.windowId, "#{pane_title}"], { check: false });
      const frame = await this.#call(["capture-pane", "-p", "-t", existing.windowId, "-S", "0", "-E", "1"], { check: false });
      const viewState = title.code !== 0 || frame.code !== 0 ? "unknown"
        : retainedCodexViewState(session.nativeId, title.stdout, frame.stdout, knownNativeIds);
      this.#eventLog.record("session_view_identity_checked", {
        sessionId: session.id, windowId: existing.windowId, viewState,
        titleQueryCode: title.code, frameQueryCode: frame.code,
      });
      changedView = viewState === "different";
    }
    if (inUse && changedView) throw viewInUse();
    if (existing && !existing.paneDead && !force && !changedView) {
      await this.#setSessionWindowMetadata(existing.windowId, session, commandSpec);
      await finish(existing.windowId, false);
      return { reused: true, windowId: existing.windowId };
    }
    if (existing) {
      const reason = force ? "forced_reattach" : changedView ? "native_view_changed" : "dead_view";
      this.#eventLog.record("session_view_respawn_requested", { sessionId: session.id, windowId: existing.windowId, reason });
      const revived = await this.#call([
        "respawn-window", ...(shared && existing.paneDead ? [] : ["-k"]), "-t", existing.windowId, "-c", commandSpec.cwd,
        this.#sessionCommand(session, commandSpec),
      ], { check: !(shared && existing.paneDead) });
      if (revived.code !== 0) {
        // Without -k, tmux atomically refuses a second opener once the pane is live.
        const current = await this.#call(["display-message", "-p", "-t", existing.windowId, "#{pane_dead}"]);
        if (current.stdout.trim() !== "0") throw Object.assign(new Error(revived.stderr || "Cannot revive frontend"), { code: "TMUX_WINDOW_FAILED" });
        await finish(existing.windowId, false);
        return { reused: true, windowId: existing.windowId };
      }
      await this.#setSessionWindowMetadata(existing.windowId, session, commandSpec);
      this.#eventLog.record("session_view_respawned", { sessionId: session.id, windowId: existing.windowId, reason });
      if (shared && (session.provider ?? session.id.split(":", 1)[0]) === "codex" && !stagedCodex) await select(existing.windowId);
      await this.#waitForSettledFrame(existing.windowId);
      await this.#call(["set-window-option", "-t", existing.windowId, "@waga_session_id", session.id]);
      await finish(existing.windowId, true);
      return { reused: true, windowId: existing.windowId };
    }

    this.#eventLog.record("session_view_open_requested", { sessionId: session.id, reason: "dock_open" });
    const created = await this.#call([
      ...(shared ? ["new-session", "-d", "-P", "-F", "#{window_id}", "-s", storageName] : ["new-window", "-d", "-P", "-F", "#{window_id}", "-t", sessionName]),
      "-n", safeWindowName(session), "-c", commandSpec.cwd,
      this.#sessionCommand(session, commandSpec),
    ], { check: !shared });
    if (created.code !== 0) {
      // tmux's unique session name is the atomic admission point across processes.
      const winner = await this.#call(["list-windows", "-t", storageName, "-F", "#{window_id}"]);
      const windowId = winner.stdout.trim();
      if (!/^@[0-9]+$/.test(windowId)) throw Object.assign(new Error(created.stderr || "Cannot open retained frontend"), { code: "TMUX_WINDOW_FAILED" });
      await finish(windowId, true);
      return { reused: true, windowId };
    }
    const windowId = created.stdout.trim();
    if (!/^@[0-9]+$/.test(windowId)) throw Object.assign(new Error("tmux did not return the native session window id"), { code: "TMUX_WINDOW_FAILED" });
    try {
      await this.#setSessionWindowMetadata(windowId, session, commandSpec);
      await this.#styleWindow([], windowId);
      if (shared && (session.provider ?? session.id.split(":", 1)[0]) === "codex" && !stagedCodex) await select(windowId);
      if (shared) await this.#waitForSettledFrame(windowId);
      await this.#call(["set-window-option", "-t", windowId, "@waga_session_id", session.id]);
      this.#eventLog.record("session_view_opened", { sessionId: session.id, windowId, reason: "dock_open" });
      await finish(windowId, true);
    } catch (error) {
      // A shared frontend may already be linked by another opener; retain it on failure.
      if (!shared) { try { await this.#call(["kill-window", "-t", windowId]); } catch {} }
      throw error;
    }
    return { reused: false, windowId };
  }

  async renameSessionView(session) {
    const sessionName = await this.#currentSessionName();
    const storageName = this.#env.WAGA_TMUX_INDEPENDENT === "1" ? retainedSessionName(session.id) : sessionName;
    const listed = await this.#call(["list-windows", "-t", storageName, "-F", "#{window_id}\t#{@waga_session_id}\t#{pane_dead}"], { check: false });
    if (listed.code !== 0) return { renamed: false };
    const existing = parseWindows(listed.stdout).find((entry) => entry.sessionId === session.id);
    if (!existing) return { renamed: false };
    await this.#setSessionWindowName(existing.windowId, session);
    return { renamed: true, windowId: existing.windowId };
  }

  async #selectView(sessionName, windowId, shared = false) {
    if (shared) {
      const listed = await this.#call(["list-windows", "-t", sessionName, "-F", "#{window_id}"]);
      if (!listed.stdout.split("\n").includes(windowId)) {
        await this.#call(["link-window", "-d", "-s", windowId, "-t", `${sessionName}:`]);
      }
      await this.#call(["set-window-option", "-t", windowId, "window-size", "latest"]);
      await this.#call(["set-window-option", "-t", windowId, "aggressive-resize", "on"]);
    }
    await this.#call(["select-window", "-t", `${sessionName}:${windowId}`]);
  }

  async focusAgentsViewFromWindow(windowId, targetSession = null) {
    if (targetSession !== null && !/^\$[0-9]+$/.test(targetSession)) throw Object.assign(new Error("Invalid tmux session id"), { code: "TMUX_SESSION_UNAVAILABLE" });
    if (!/^@[0-9]+$/.test(windowId)) {
      throw Object.assign(new Error(`Invalid tmux window id: ${windowId}`), { code: "TMUX_WINDOW_INVALID" });
    }
    const providerResult = await this.#call(["show-options", "-w", "-v", "-t", windowId, "@waga_provider"], { check: false });
    const provider = providerResult.stdout.trim();
    if (!["claude", "codex"].includes(provider)) return { code: 0, ignored: true };
    const cwdResult = await this.#call(["show-options", "-w", "-v", "-t", windowId, "@waga_project_cwd"], { check: false });
    const cwd = cwdResult.stdout.trim();
    if (!cwd) throw Object.assign(new Error(`Waga session window is missing its project cwd: ${windowId}`), { code: "TMUX_WINDOW_INVALID" });
    const sessionName = targetSession ?? (await this.#call(["display-message", "-p", "-t", windowId, "#{session_name}"])).stdout.trim();
    const commandSpec = nativeAgentsCommand(provider, { cwd });
    const listed = await this.#call(["list-windows", "-t", sessionName, "-F", "#{window_id}\t#{@waga_agents_provider}\t#{pane_dead}"]);
    const existing = parseWindows(listed.stdout).find((entry) => entry.sessionId === provider);
    if (existing && !existing.paneDead) {
      await this.#selectView(sessionName, existing.windowId);
      return { reused: true, windowId: existing.windowId };
    }

    let agentsWindowId = existing?.windowId;
    if (agentsWindowId) {
      await this.#call(["respawn-window", "-k", "-t", agentsWindowId, "-c", commandSpec.cwd, this.#colorCommand(provider, commandSpec.command, commandSpec.args)]);
    } else {
      const created = await this.#call([
        "new-window", "-d", "-P", "-F", "#{window_id}", "-t", sessionName,
        "-n", `${provider === "claude" ? "Claude" : "Codex"} Agents`, "-c", commandSpec.cwd,
        this.#colorCommand(provider, commandSpec.command, commandSpec.args),
      ]);
      agentsWindowId = created.stdout.trim();
      if (!agentsWindowId) throw Object.assign(new Error("tmux did not return the Agents view window id"), { code: "TMUX_WINDOW_FAILED" });
    }
    await this.#call(["set-window-option", "-t", agentsWindowId, "@waga_agents_provider", provider]);
    await this.#call(["set-window-option", "-t", agentsWindowId, "@waga_provider", provider]);
    await this.#call(["set-window-option", "-t", agentsWindowId, "@waga_project_cwd", commandSpec.cwd]);
    await this.#call(["set-window-option", "-t", agentsWindowId, "automatic-rename", "off"]);
    await this.#styleWindow([], agentsWindowId);
    await this.#selectView(sessionName, agentsWindowId);
    return { reused: false, windowId: agentsWindowId };
  }

  async closeSessionView(session) {
    const sessionName = this.#env.WAGA_TMUX_SESSION || (await this.#call(["display-message", "-p", "#{session_name}"])).stdout.trim();
    if (!sessionName) throw Object.assign(new Error("Waga tmux session is unavailable"), { code: "TMUX_SESSION_UNAVAILABLE" });
    const storageName = this.#env.WAGA_TMUX_INDEPENDENT === "1" ? retainedSessionName(session.id) : sessionName;
    const listed = await this.#call(["list-windows", "-t", storageName, "-F", "#{window_id}\t#{@waga_session_id}"], { check: false });
    if (listed.code !== 0) return { closed: false };
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
    const closed = [];
    for (const entry of stale) {
      const interactive = await this.#call(["show-options", "-w", "-v", "-t", entry.windowId, "@waga_interactive"], { check: false });
      if (interactive.stdout.trim() === "1") continue;
      const details = { sessionId: entry.sessionId, windowId: entry.windowId, reason: "provider_missing_from_loaded_set" };
      this.#eventLog.record("session_view_close_requested", details);
      await this.#call(["kill-window", "-t", entry.windowId]);
      this.#eventLog.record("session_view_closed", details);
      closed.push(entry.sessionId);
    }
    return { closed };
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
    if (this.#env.WAGA_TMUX_INDEPENDENT === "1") {
      const clients = await this.#call(["list-clients", "-t", sessionName, "-F", "#{client_name}"]);
      for (const client of clients.stdout.split("\n").filter(Boolean)) {
        if (this.#env.WAGA_TMUX_MODE === "existing") {
          const switched = await this.#call(["switch-client", "-c", client, "-l"], { check: false });
          if (switched.code === 0) continue;
        }
        await this.#call(["detach-client", "-t", client, "-E", EXIT_COMMAND], { check: false });
      }
      await this.#call(["kill-session", "-t", sessionName], { check: false });
      return { closeOverview: true };
    }
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
    const args = [
      this.#sessionHostPath,
      provider,
      session.id,
      "--",
      commandSpec.command,
      ...commandSpec.args,
    ];
    if (provider === "codex" && this.#env.WAGA_TMUX_INDEPENDENT === "1") {
      return shellCommand("env", [`WAGA_WAIT_FOR_VISIBLE=${commandSpec.afterAttach ? "0" : "1"}`, this.#nodePath, ...args]);
    }
    return this.#colorCommand(provider, this.#nodePath, args);
  }

  #colorCommand(provider, command, args) {
    if (provider === "claude" && this.#env.WAGA_TMUX_MODE === "isolated") {
      return shellCommand("env", ["CLAUDE_CODE_TMUX_TRUECOLOR=1", command, ...args]);
    }
    return shellCommand(command, args);
  }

  async #setSessionWindowMetadata(windowId, session, commandSpec) {
    const provider = session.provider ?? String(session.id).split(":", 1)[0];
    const projectCwd = path.resolve(session.projectCwd ?? commandSpec.cwd);
    await this.#call(["set-window-option", "-t", windowId, "@waga_provider", provider]);
    await this.#call(["set-window-option", "-t", windowId, "@waga_project_cwd", projectCwd]);
    await this.#setSessionWindowName(windowId, session);
  }

  async #setSessionWindowName(windowId, session) {
    await this.#call(["set-window-option", "-t", windowId, "automatic-rename", "off"]);
    await this.#call(["rename-window", "-t", windowId, safeWindowName(session)]);
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

  async #waitForCodexAttach(windowId, nativeId) {
    const deadline = Date.now() + CODEX_ATTACH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = await this.#call(["display-message", "-p", "-t", windowId, "#{pane_dead}\t#{pane_title}"], { check: false });
      if (state.code !== 0) throw Object.assign(new Error("Codex frontend disappeared during attach"), { code: "CODEX_ATTACH_FAILED" });
      const [dead, title] = state.stdout.trim().split("\t", 2);
      if (dead === "1") throw Object.assign(new Error("Codex frontend exited before attach completed"), { code: "CODEX_ATTACH_FAILED" });
      const captured = await this.#call(["capture-pane", "-p", "-t", windowId], { check: false });
      const frame = captured.code === 0 ? captured.stdout : "";
      if (retainedCodexViewState(nativeId, title, frame) === "same"
          && frame.includes("›") && !/Resuming session|Trust this folder\?/.test(frame)) return;
      await this.#wait(VIEW_SETTLE_POLL_MS);
    }
    throw Object.assign(new Error("Codex frontend did not finish attaching before permission synchronization"), { code: "CODEX_ATTACH_TIMEOUT" });
  }

  async #configure(prefix, sessionName, mode) {
    const options = [
      ["status", "on"],
      ["status-position", "top"],
      ["status-interval", "1"],
      ["status-style", "bg=#0f172a,fg=#e2e8f0"],
      ["status-left", this.#env.WAGA_REMOTE_HOST
        ? `#[bold,fg=#38bdf8] Waga · ${String(this.#env.WAGA_REMOTE_HOST).replaceAll("#", "##").replace(/[\x00-\x1f\x7f-\x9f]/g, " ")} #[default]│ `
        : "#[bold,fg=#38bdf8] Waga #[default]│ "],
      ["status-left-length", this.#env.WAGA_REMOTE_HOST ? "96" : "20"],
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
      for (const key of ["M-g", "M-G", "M-ㅎ"]) {
        await this.#call([...prefix, "bind-key", "-n", key, "if-shell", "-F", "#{&&:#{!=:#{@waga_remote_host},},#{==:#{pane_dead},0}}", "send-keys M-g", "select-window -t :overview ; send-keys -t :overview M-r"]);
      }
      const agentsViewCommand = shellCommand("env", ["WAGA_TMUX_TARGET_SESSION=#{session_id}", "WAGA_TMUX_MODE=isolated", this.#nodePath, this.#cliPath, "tmux-agents-view", "#{window_id}"]);
      for (const key of ["M-a", "M-A", "M-ㅁ"]) {
        await this.#call([...prefix, "bind-key", "-n", key, "if-shell", "-F", "#{&&:#{!=:#{@waga_remote_host},},#{==:#{pane_dead},0}}", "send-keys M-a", `run-shell -b ${quote(agentsViewCommand)}`]);
      }
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

export async function enterWagaDock({ cwd = process.cwd(), filterCwd = null, hostsPath = null, workspace = new TmuxWorkspace() } = {}) {
  return workspace.enter({ cwd, filterCwd, hostsPath });
}
