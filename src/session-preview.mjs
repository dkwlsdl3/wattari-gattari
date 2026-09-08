import fs from "node:fs/promises";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";

const TEXT_LIMIT = 4_000;
const TAIL_BYTES = 256 * 1024;

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

export async function readClaudePreview(session, { homeDirectory, signal } = {}) {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(session.sessionId) || !path.isAbsolute(session.cwd)) {
    throw new Error("Invalid Claude preview identity");
  }
  signal?.throwIfAborted();
  const project = session.cwd.replace(/[^a-zA-Z0-9]/g, "-");
  const filename = path.join(homeDirectory, ".claude", "projects", project, `${session.sessionId}.jsonl`);
  const file = await fs.open(filename, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Claude transcript is not a file");
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const buffer = Buffer.alloc(Math.min(stat.size, TAIL_BYTES));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
    signal?.throwIfAborted();
    const lines = buffer.toString("utf8", 0, bytesRead).split("\n");
    if (start) lines.shift(); // Never parse a partial record at the tail boundary.
    const incomplete = Boolean(lines.pop()); // A writer may still be appending the last record.
    const result = { input: "", output: "", limited: start > 0 || incomplete };
    for (const line of lines.reverse()) {
      let row;
      try { row = JSON.parse(line); } catch { result.limited = true; continue; }
      if (row.sessionId !== session.sessionId || row.isSidechain || row.isMeta) continue;
      if (row.type === "user" && !result.input && (!row.origin || row.origin.kind === "human") && !row.toolUseResult) {
        const content = row.message?.content;
        const toolResult = Array.isArray(content) && content.some((block) => block?.type === "tool_result");
        if (!toolResult && (typeof content === "string" || Array.isArray(content))) result.input = messageText(content) || "[텍스트 없는 입력]";
      }
      if (row.type === "assistant" && !result.output) result.output = messageText(row.message?.content);
      if (result.input && result.output) break;
    }
    return result;
  } finally { await file.close(); }
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
    if (session?.id !== this.#session?.id) {
      clearTimeout(this.#timer); this.#timer = null;
      this.#running?.abort();
    }
    this.#session = session;
    if (!session || this.#running || this.#timer) return;
    const cached = this.#cache.get(session.id);
    if (cached && this.#now() - cached.checkedAt < this.#ttl) return;
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
        value = { state: "ready", input: previewText(result.input), output: previewText(result.output), limited: Boolean(result.limited) };
      } catch {
        value = { state: "error" }; // Do not leak provider error bodies into the terminal.
      }
      if (controller.signal.aborted || this.#closed) return;
      this.#cache.delete(session.id);
      this.#cache.set(session.id, { ...value, checkedAt: this.#now() });
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
