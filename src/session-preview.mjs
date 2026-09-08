import fs from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

const TEXT_LIMIT = 4_000;
const CHUNK_BYTES = 256 * 1024;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;

// Preview text is untrusted terminal content, never terminal instructions.
export function previewText(value) {
  if (typeof value !== "string") return "";
  const text = stripVTControlCharacters(value.slice(0, TEXT_LIMIT + 256))
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").trim();
  return text.length > TEXT_LIMIT || value.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text;
}

export function messageText(content) {
  if (typeof content === "string") return previewText(content);
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const block of content) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    text += `${text ? "\n" : ""}${block.text.slice(0, TEXT_LIMIT + 1)}`;
    if (text.length > TEXT_LIMIT) break;
  }
  return previewText(text);
}

function claudePreviewPath(session, homeDirectory) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(session.sessionId) || !path.isAbsolute(session.cwd)) {
    throw new Error("Invalid Claude preview identity");
  }
  const project = session.cwd.replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(homeDirectory, ".claude", "projects", project, `${session.sessionId}.jsonl`);
}

function acceptClaudeLine(line, session, result) {
  if (!line.length) return;
  let row;
  try { row = JSON.parse(line); } catch { result.skipped = true; return; }
  if (!row || typeof row !== "object") { result.skipped = true; return; }
  if (row.sessionId !== session.sessionId || row.isSidechain || row.isMeta) return;
  if (row.type === "user" && !result.input && (!row.origin || row.origin.kind === "human") && !row.toolUseResult) {
    const content = row.message?.content;
    const toolResult = Array.isArray(content) && content.some((block) => block?.type === "tool_result");
    if (!toolResult && (typeof content === "string" || Array.isArray(content))) result.input = messageText(content) || "[텍스트 없는 입력]";
  }
  if (row.type === "assistant" && !result.output) result.output = messageText(row.message?.content);
}

// Scan complete records backwards, stopping as soon as both latest messages are found.
// I/O yields between chunks; neither the entire file nor unbounded records enter memory.
async function scanClaudeRange(file, start, end, session, signal) {
  const result = { input: "", output: "", skipped: false, offset: start };
  let position = end, carry = Buffer.alloc(0), oversized = false, trailing = true;
  const accept = (piece, boundary) => {
    if (carry.length + piece.length > MAX_RECORD_BYTES) { oversized = true; carry = Buffer.alloc(0); }
    if (!oversized) carry = Buffer.concat([piece, carry]);
    if (!boundary) return;
    if (trailing) trailing = false; // Ignore the unfinished final record (possibly empty).
    else if (oversized) result.skipped = true;
    else acceptClaudeLine(carry.toString("utf8"), session, result);
    carry = Buffer.alloc(0); oversized = false;
  };
  while (position > start) {
    signal?.throwIfAborted();
    const size = Math.min(CHUNK_BYTES, position - start);
    position -= size;
    const buffer = Buffer.alloc(size);
    let filled = 0;
    while (filled < size) {
      signal?.throwIfAborted();
      const { bytesRead } = await file.read(buffer, filled, size - filled, position + filled);
      if (!bytesRead) throw Object.assign(new Error("Transcript changed during read"), { code: "ESTALE" });
      filled += bytesRead;
    }
    let right = size;
    for (let newline = buffer.lastIndexOf(10); newline >= 0; newline = newline ? buffer.lastIndexOf(10, newline - 1) : -1) {
      if (trailing) result.offset = position + newline + 1;
      accept(buffer.subarray(newline + 1, right), true);
      if (result.input && result.output) return result;
      right = newline;
    }
    accept(buffer.subarray(0, right), false);
  }
  accept(Buffer.alloc(0), true);
  return result;
}

export class ClaudePreviewReader {
  #cache = new Map();
  #open;
  constructor({ open = fs.open } = {}) { this.#open = open; }
  async read(session, { homeDirectory, signal } = {}) {
    const filename = claudePreviewPath(session, homeDirectory);
    signal?.throwIfAborted();
    const file = await this.#open(filename, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error("Claude transcript is not a file");
      let previous = this.#cache.get(filename);
      if (previous && (previous.ino !== stat.ino || previous.dev !== stat.dev || stat.size < previous.size
        || (stat.size === previous.size && stat.mtimeMs !== previous.mtimeMs))) previous = null;
      if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs) return { ...previous.value };
      const scan = await scanClaudeRange(file, previous?.offset ?? 0, stat.size, session, signal);
      signal?.throwIfAborted();
      const skipped = scan.skipped || previous?.skipped || false;
      const value = { input: scan.input || previous?.value.input || "", output: scan.output || previous?.value.output || "",
        limited: skipped || scan.offset < stat.size };
      this.#cache.delete(filename);
      this.#cache.set(filename, { ino: stat.ino, dev: stat.dev, size: stat.size, mtimeMs: stat.mtimeMs, offset: scan.offset, skipped, value });
      if (this.#cache.size > 20) this.#cache.delete(this.#cache.keys().next().value);
      return { ...value };
    } finally { await file.close(); }
  }
}

export function readClaudePreview(session, options) {
  return new ClaudePreviewReader().read(session, options);
}

function previewError(error) {
  if (error?.code === "ENOENT") return "로그 파일 없음";
  if (["EACCES", "EPERM"].includes(error?.code)) return "읽기 권한 없음";
  if (error?.code === "ESTALE") return "로그 변경 중";
  if (["CODEX_RPC_TIMEOUT", "ETIMEDOUT"].includes(error?.code) || error?.name === "TimeoutError") return "조회 시간 초과";
  if (["ECONNREFUSED", "CODEX_APP_SERVER_CLOSED", "CODEX_DAEMON_UNAVAILABLE"].includes(error?.code)) return "연결 불가";
  return "조회 오류";
}

// A single in-flight read, a short selection debounce, and a bounded in-memory cache.
// The overview's existing visible-only refresh drives expiry; there is no poller here.
export class SessionPreview {
  #read; #visible; #changed; #now; #delay; #ttl;
  #cache = new Map(); #session = null; #timer = null; #running = null; #closed = false;
  constructor({ read, visible, changed, now = Date.now, debounceMs = 150, cacheMs = 5_000 }) {
    this.#read = read; this.#visible = visible; this.#changed = changed;
    this.#now = now; this.#delay = debounceMs; this.#ttl = cacheMs;
  }
  select(session) {
    if (this.#closed) return;
    if (session?.id !== this.#session?.id || session?.cwd !== this.#session?.cwd) {
      clearTimeout(this.#timer); this.#timer = null;
      this.#running?.abort();
    }
    this.#session = session;
    if (!session || this.#running || this.#timer) return;
    const cached = this.#cache.get(session.id);
    if (cached && cached.cwd === session.cwd && this.#now() - cached.checkedAt < this.#ttl) return;
    this.#timer = setTimeout(() => { this.#timer = null; void this.#load(session); }, this.#delay);
  }
  snapshot(session) {
    return session ? this.#cache.get(session.id) ?? { state: "loading" } : null;
  }
  async #load(session) {
    const controller = new AbortController();
    this.#running = controller;
    try {
      if (!await this.#visible() || controller.signal.aborted || this.#closed) return;
      let value;
      try {
        const result = await this.#read(session, { signal: controller.signal });
        value = { state: "ready", input: previewText(result.input), output: previewText(result.output), limited: Boolean(result.limited), observedAt: this.#now() };
      } catch (error) {
        const previous = this.#cache.get(session.id);
        // Retain only this identity's last successful data; never expose raw error bodies.
        value = { ...(previous?.state === "ready" ? previous : { state: "error" }), error: previewError(error) };
      }
      if (controller.signal.aborted || this.#closed) return;
      this.#cache.delete(session.id);
      this.#cache.set(session.id, { ...value, cwd: session.cwd, checkedAt: this.#now() });
      if (this.#cache.size > 20) this.#cache.delete(this.#cache.keys().next().value);
      if (await this.#visible() && !controller.signal.aborted && !this.#closed) this.#changed();
    } catch { /* Visibility failures must not break navigation or cause retries. */ }
    finally {
      this.#running = null;
      if (!this.#closed && (controller.signal.aborted || session.id !== this.#session?.id)) this.select(this.#session);
    }
  }
  close() {
    this.#closed = true; clearTimeout(this.#timer); this.#running?.abort(); this.#cache.clear();
  }
}
