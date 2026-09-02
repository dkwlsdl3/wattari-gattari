import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { SessionAliasCatalog } from "./session-alias-catalog.mjs";

const execFileAsync = promisify(execFile);
const SHORT_ID = /^[0-9a-f]{8}$/i;

class ClaudeSessionError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
  }
}

async function defaultRun(args, { cwd } = {}) {
  return execFileAsync("claude", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    timeout: 30_000,
  });
}

function canonical(input) {
  const resolved = path.resolve(input);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

export function parseClaudeAgents(stdout) {
  let rows;
  try {
    rows = JSON.parse(stdout);
  } catch (cause) {
    throw new ClaudeSessionError("CLAUDE_AGENTS_OUTPUT_INVALID", "Claude CLI가 올바른 JSON을 반환하지 않았습니다", { cause });
  }
  if (!Array.isArray(rows)) {
    throw new ClaudeSessionError("CLAUDE_AGENTS_OUTPUT_INVALID", "Claude agents 출력은 배열이어야 합니다");
  }
  for (const row of rows) {
    if (!row || !SHORT_ID.test(row.id) || typeof row.sessionId !== "string" || typeof row.cwd !== "string") {
      throw new ClaudeSessionError("CLAUDE_AGENTS_OUTPUT_INVALID", "Claude agents 항목의 필수 필드가 없습니다");
    }
  }
  return rows;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function publicStatus(row, jobState) {
  if (jobState?.needs) return "Needs input";
  if (row.status === "busy" || row.state === "working") return "Working";
  if (row.status === "idle" && processAlive(row.pid)) return "Awaiting input";
  return "Sleeping";
}

export class ClaudeSessionService extends EventEmitter {
  provider = "claude";
  #cwd;
  #claudeHome;
  #run;
  #aliases;
  #watchers = new Map();
  #connected = false;

  constructor({
    cwd = process.cwd(),
    claudeHome = path.join(os.homedir(), ".claude"),
    aliasCatalogPath,
    run = defaultRun,
  } = {}) {
    super();
    if (!aliasCatalogPath) throw new TypeError("ClaudeSessionService requires aliasCatalogPath");
    this.#cwd = canonical(cwd);
    this.#claudeHome = claudeHome;
    this.#run = run;
    this.#aliases = new SessionAliasCatalog(aliasCatalogPath);
  }

  async connect() {
    if (this.#connected) return;
    await this.listSessions();
    this.#connected = true;
    this.#watch(path.join(this.#claudeHome, "daemon"));
    this.#watch(path.join(this.#claudeHome, "jobs"));
  }

  async detach() {
    this.#connected = false;
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
  }

  async listSessions() {
    const { stdout } = await this.#run(["agents", "--json", "--all"], { cwd: this.#cwd });
    const sessions = [];
    for (const row of parseClaudeAgents(stdout)) {
      if (canonical(row.cwd) !== this.#cwd) continue;
      // `claude attach` and `claude stop` are background-session contracts.
      // Other future surfaces must not be advertised as native handoff targets.
      if (row.kind !== "background") continue;
      const jobState = this.#readJobState(row.id, row.sessionId);
      this.#watch(path.join(this.#claudeHome, "jobs", row.id));
      const status = publicStatus(row, jobState);
      const id = `claude:${row.id}`;
      if (this.#aliases.isHidden(id)) {
        if (row.status) this.#aliases.unhide(id);
        else continue;
      }
      sessions.push({
        id,
        threadId: row.id,
        sessionId: row.sessionId,
        provider: "claude",
        kind: row.kind,
        name: this.#aliases.get(id) ?? row.name ?? row.id,
        cwd: this.#cwd,
        status,
        lastActivity: jobState?.detail || row.name || "Claude session",
        updatedAt: Date.parse(jobState?.updatedAt ?? row.startedAt ?? "") || 0,
        routable: true,
        controllable: true,
        workingSince: status === "Working"
          ? Date.parse(jobState?.createdAt ?? row.startedAt ?? "") || null
          : null,
        model: row.model ?? null,
        reasoningEffort: row.effort ?? null,
      });
    }
    return sessions.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async renameSession(threadId, name, selectedSession = null) {
    if (typeof name !== "string" || !name.trim()) throw new ClaudeSessionError("INVALID_NAME", "세션 이름이 필요합니다");
    const session = await this.#findSession(threadId, selectedSession);
    this.#aliases.set(session.id, name.trim());
    this.emit("changed", { method: "waga/claude-renamed", params: { threadId } });
  }

  async stopSession(threadId, selectedSession = null) {
    const session = await this.#findSession(threadId, selectedSession, { fresh: true });
    if (!session.controllable) {
      throw new ClaudeSessionError("SESSION_NOT_CONTROLLABLE", "background Claude 세션만 종료할 수 있습니다");
    }
    await this.#run(["stop", threadId], { cwd: session.cwd });
    this.#aliases.remove(session.id);
    this.#aliases.hide(session.id);
    this.emit("changed", { method: "waga/claude-stopped", params: { threadId } });
  }

  async #findSession(threadId, selectedSession, { fresh = false } = {}) {
    if (!fresh && selectedSession?.provider === "claude" && selectedSession.threadId === threadId) return selectedSession;
    const session = (await this.listSessions()).find((candidate) => candidate.threadId === threadId);
    if (!session) throw new ClaudeSessionError("SESSION_NOT_FOUND", `Claude 세션을 찾을 수 없습니다: ${threadId}`);
    return session;
  }

  #readJobState(shortId, expectedSessionId) {
    const filePath = path.join(this.#claudeHome, "jobs", shortId, "state.json");
    try {
      const state = JSON.parse(fs.readFileSync(filePath, "utf8"));
      if (state.daemonShort !== shortId || state.sessionId !== expectedSessionId) return null;
      return state;
    } catch {
      return null;
    }
  }

  #watch(directory) {
    if (!fs.existsSync(directory) || this.#watchers.has(directory)) return;
    try {
      const watcher = fs.watch(directory, { persistent: false }, () => this.emit("changed", { method: "claude/state-changed" }));
      watcher.on("error", () => {
        watcher.close();
        this.#watchers.delete(directory);
      });
      this.#watchers.set(directory, watcher);
    } catch {
      // Explicit refreshes still work when a directory cannot be watched.
    }
  }
}
