import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { SessionAliasCatalog } from "./session-alias-catalog.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_PAGE_SIZE = 100;
const INITIAL_SCAN_BYTES = 256 * 1024;
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

function safeJson(text, code) {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ClaudeSessionError(code, "Claude CLI가 올바른 JSON을 반환하지 않았습니다", { cause });
  }
}

export function parseClaudeAgents(stdout) {
  const rows = safeJson(stdout, "CLAUDE_AGENTS_OUTPUT_INVALID");
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

export function parseBackgroundSessionId(stdout) {
  const lines = String(stdout).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const exact = lines.findLast((line) => SHORT_ID.test(line));
  if (exact) return exact.toLowerCase();
  const labelled = lines.join("\n").match(/(?:backgrounded|session|agent|id)[^\n]*?\b([0-9a-f]{8})\b/i);
  if (labelled) return labelled[1].toLowerCase();
  throw new ClaudeSessionError("CLAUDE_BACKGROUND_ID_MISSING", "Claude가 background session id를 반환하지 않았습니다");
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
  if (row.status === "busy") return "Working";
  if (row.status === "idle" && processAlive(row.pid)) return "Awaiting input";
  if (row.state === "working") return "Working";
  return "Sleeping";
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function publicTranscriptMessage(record) {
  if (record?.type !== "user" && record?.type !== "assistant") return null;
  if (record.message?.role !== record.type) return null;
  const text = messageText(record.message.content);
  if (!text) return null;
  return {
    id: record.uuid ?? `${record.type}:${record.timestamp ?? "unknown"}`,
    role: record.type === "user" ? "user" : "agent",
    text,
  };
}

export async function readClaudeTranscriptPage(filePath, endOffset, limit = DEFAULT_PAGE_SIZE) {
  const handle = await fs.promises.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const end = Math.max(0, Math.min(endOffset ?? stat.size, stat.size));
    let windowSize = Math.min(INITIAL_SCAN_BYTES, Math.max(1, end));
    while (true) {
      const start = Math.max(0, end - windowSize);
      const buffer = Buffer.alloc(end - start);
      if (buffer.length) await handle.read(buffer, 0, buffer.length, start);
      let first = 0;
      if (start > 0) {
        const newline = buffer.indexOf(0x0a);
        first = newline < 0 ? buffer.length : newline + 1;
      }
      const entries = [];
      let lineStart = first;
      for (let index = first; index <= buffer.length; index += 1) {
        if (index !== buffer.length && buffer[index] !== 0x0a) continue;
        if (index > lineStart) {
          try {
            const record = JSON.parse(buffer.subarray(lineStart, index).toString("utf8"));
            const message = publicTranscriptMessage(record);
            if (message) entries.push({ offset: start + lineStart, message });
          } catch {
            // A concurrently appended final line or an unrelated malformed record is ignored.
          }
        }
        lineStart = index + 1;
      }
      if (entries.length >= limit || start === 0) {
        const selected = entries.slice(-limit);
        return {
          messages: selected.map((entry) => entry.message),
          olderOffset: selected.length ? selected[0].offset : 0,
          fileSize: stat.size,
        };
      }
      windowSize = Math.min(end, windowSize * 2);
    }
  } finally {
    await handle.close();
  }
}

function mergeMessages(existing, incoming, prepend = false) {
  const all = prepend ? [...incoming, ...existing] : [...existing, ...incoming];
  const seen = new Set();
  return all.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

export class ClaudeSessionService extends EventEmitter {
  provider = "claude";
  #cwd;
  #claudeHome;
  #run;
  #aliases;
  #watchers = new Map();
  #transcripts = new Map();
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
    const rows = parseClaudeAgents(stdout);
    const sessions = [];
    for (const row of rows) {
      if (canonical(row.cwd) !== this.#cwd) continue;
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
        kind: row.kind ?? "background",
        name: this.#aliases.get(id) ?? row.name ?? row.id,
        cwd: this.#cwd,
        status,
        lastActivity: jobState?.detail || row.name || "Claude background session",
        updatedAt: Date.parse(jobState?.updatedAt ?? row.startedAt ?? "") || 0,
        routable: row.kind === "background" && status === "Awaiting input",
        controllable: row.kind === "background",
      });
    }
    return sessions.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async createSession({ prompt, name = null, cwd = this.#cwd } = {}) {
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new ClaudeSessionError("INVALID_PROMPT", "새 Claude 세션의 최초 프롬프트가 필요합니다");
    }
    const args = ["--background", "--permission-mode", "manual"];
    const resolvedName = (name || prompt.trim()).slice(0, 80);
    if (resolvedName) args.push("--name", resolvedName);
    args.push(prompt.trim());
    const { stdout } = await this.#run(args, { cwd });
    const shortId = parseBackgroundSessionId(stdout);
    this.#aliases.unhide(`claude:${shortId}`);
    const session = await this.#waitForSession(shortId);
    this.emit("changed", { method: "waga/claude-created", params: { threadId: shortId } });
    return session;
  }

  async openSession(threadId, selectedSession = null) {
    let session = await this.#findSession(threadId, selectedSession);
    if (session.status === "Sleeping" && session.controllable) {
      const { stdout } = await this.#run(["--background", "--resume", session.sessionId], { cwd: session.cwd });
      const returnedId = parseBackgroundSessionId(stdout);
      if (returnedId !== threadId) {
        throw new ClaudeSessionError("CLAUDE_RESUME_FORKED", `Claude가 ${threadId} 대신 ${returnedId} 세션을 만들었습니다`);
      }
      this.#aliases.unhide(session.id);
      session = await this.#waitForSession(threadId);
      this.emit("changed", { method: "waga/claude-woke", params: { threadId } });
    }
    return { ...session, ...await this.#readRecentTranscript(session) };
  }

  async readSession(threadId, selectedSession = null) {
    const session = await this.#findSession(threadId, selectedSession);
    return { ...session, ...await this.#readRecentTranscript(session) };
  }

  async loadOlderMessages(threadId, selectedSession = null) {
    const session = await this.#findSession(threadId, selectedSession);
    const current = this.#transcripts.get(threadId) ?? await this.#fetchRecentTranscript(session);
    if (!current.olderOffset) return { ...session, messages: current.messages, hasOlderMessages: false };
    const page = await readClaudeTranscriptPage(current.filePath, current.olderOffset);
    const next = {
      ...current,
      messages: mergeMessages(current.messages, page.messages, true),
      olderOffset: page.olderOffset,
      expanded: true,
    };
    this.#transcripts.set(threadId, next);
    return { ...session, messages: next.messages, hasOlderMessages: next.olderOffset > 0 };
  }

  async sendMessage(threadId, text, selectedSession = null) {
    if (typeof text !== "string" || !text.trim()) {
      throw new ClaudeSessionError("INVALID_MESSAGE", "보낼 메시지가 필요합니다");
    }
    const session = await this.#findSession(threadId, selectedSession, { fresh: true });
    if (!session.controllable) throw new ClaudeSessionError("SESSION_NOT_CONTROLLABLE", "background Claude 세션만 제어할 수 있습니다");
    if (session.status === "Working" || session.status === "Needs input") {
      throw new ClaudeSessionError("TURN_IN_PROGRESS", "실행 중인 Claude 세션은 복제 방지를 위해 현재 턴이 끝난 뒤 메시지를 보낼 수 있습니다");
    }
    if (session.status === "Awaiting input") {
      await this.#run(["stop", threadId], { cwd: session.cwd });
    }
    const { stdout } = await this.#run(["--background", "--resume", session.sessionId, text.trim()], { cwd: session.cwd });
    const returnedId = parseBackgroundSessionId(stdout);
    if (returnedId !== threadId) {
      throw new ClaudeSessionError("CLAUDE_RESUME_FORKED", `Claude가 ${threadId} 대신 ${returnedId} 세션을 만들었습니다`);
    }
    this.#aliases.unhide(session.id);
    this.emit("changed", { method: "waga/claude-turn-started", params: { threadId } });
    return { threadId, started: true };
  }

  async renameSession(threadId, name, selectedSession = null) {
    if (typeof name !== "string" || !name.trim()) throw new ClaudeSessionError("INVALID_NAME", "세션 이름이 필요합니다");
    const session = await this.#findSession(threadId, selectedSession);
    this.#aliases.set(session.id, name);
    this.emit("changed", { method: "waga/claude-renamed", params: { threadId } });
  }

  async stopSession(threadId, selectedSession = null) {
    const session = await this.#findSession(threadId, selectedSession, { fresh: true });
    if (!session.controllable) throw new ClaudeSessionError("SESSION_NOT_CONTROLLABLE", "background Claude 세션만 제어할 수 있습니다");
    await this.#run(["stop", threadId], { cwd: session.cwd });
    this.#transcripts.delete(threadId);
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

  async #waitForSession(threadId) {
    const deadline = Date.now() + 5_000;
    do {
      const session = (await this.listSessions()).find((candidate) => candidate.threadId === threadId);
      if (session) return session;
      await new Promise((resolve) => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw new ClaudeSessionError("CLAUDE_SESSION_NOT_VISIBLE", `생성한 Claude 세션이 목록에 나타나지 않았습니다: ${threadId}`);
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

  #transcriptPath(session) {
    const state = this.#readJobState(session.threadId, session.sessionId);
    const candidate = state?.linkScanPath;
    const projectRoot = path.resolve(this.#claudeHome, "projects");
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) {
      throw new ClaudeSessionError("CLAUDE_TRANSCRIPT_NOT_FOUND", `Claude transcript 경로가 없습니다: ${session.threadId}`);
    }
    const resolved = path.resolve(candidate);
    if (resolved !== projectRoot && !resolved.startsWith(`${projectRoot}${path.sep}`)) {
      throw new ClaudeSessionError("CLAUDE_TRANSCRIPT_OUTSIDE_HOME", "Claude transcript가 예상한 projects 디렉터리 밖에 있습니다");
    }
    return resolved;
  }

  async #fetchRecentTranscript(session) {
    const filePath = this.#transcriptPath(session);
    const page = await readClaudeTranscriptPage(filePath);
    return { ...page, filePath, expanded: false };
  }

  async #readRecentTranscript(session) {
    const recent = await this.#fetchRecentTranscript(session);
    const cached = this.#transcripts.get(session.threadId);
    const next = cached?.expanded
      ? { ...cached, messages: mergeMessages(cached.messages, recent.messages), fileSize: recent.fileSize }
      : recent;
    this.#transcripts.set(session.threadId, next);
    return { messages: next.messages, hasOlderMessages: next.olderOffset > 0 };
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
      // The CLI remains usable; explicit actions still trigger refreshes.
    }
  }
}
