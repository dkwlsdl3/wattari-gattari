import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { buildPeerEnvelope } from "../bridge/envelope.mjs";
import { readBeforeDeadline } from "../bridge/deadline.mjs";
import { readClaudeUsage } from "../claude-usage.mjs";
import { ClaudeTitleSync } from "../claude-title-sync.mjs";
import { WAGA_SESSION_INSTRUCTIONS } from "../managed-session-instructions.mjs";
import { defaultClaudeAliasPath, SessionAliasCatalog } from "../session-alias-catalog.mjs";
import { ClaudePeerEndpoint } from "./claude-peer.mjs";
import { claudeReplyOffset, readClaudeReply, readClaudeReceipt, waitForClaudeReply } from "./claude-reply.mjs";
import { ClaudePreviewReader, readClaudeHistory } from "../session-preview.mjs";
import { applyClaudeExecutionSettings } from "../provider-execution.mjs";

const execFileAsync = promisify(execFile);
const SHORT_ID = /^[0-9a-f]{8}$/i;
const USAGE_CACHE_MS = 5 * 60_000;

async function defaultRun(args, { cwd, signal } = {}) {
  return execFileAsync("claude", args, { cwd, signal, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 30_000 });
}

function canonical(value) {
  const resolved = path.resolve(value);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function claudeProjectCwd(value) {
  const cwd = canonical(value);
  const worktreeMarker = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
  const markerIndex = cwd.indexOf(worktreeMarker);
  return markerIndex > 0 ? cwd.slice(0, markerIndex) : cwd;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

export function parseClaudeAgents(stdout) {
  let rows;
  try { rows = JSON.parse(stdout); } catch (cause) {
    throw Object.assign(new Error("Claude agents did not return valid JSON", { cause }), { code: "CLAUDE_AGENTS_INVALID" });
  }
  // `agents --json` also lists interactive terminals; only background jobs support attach/rm.
  if (Array.isArray(rows)) rows = rows.filter((row) => row?.kind !== "interactive");
  if (!Array.isArray(rows) || rows.some((row) => !row || !SHORT_ID.test(row.id) || typeof row.sessionId !== "string" || typeof row.cwd !== "string")) {
    throw Object.assign(new Error("Claude agents JSON does not match the expected session array"), { code: "CLAUDE_AGENTS_INVALID" });
  }
  return rows;
}

export function parseClaudeBackgroundId(stdout) {
  const match = /^backgrounded\s+·\s+([0-9a-f]{8})(?:\s+·[^\r\n]*)?\s*$/im.exec(String(stdout));
  if (!match) throw Object.assign(new Error("Claude background output is missing its session id"), { code: "CLAUDE_BACKGROUND_INVALID" });
  return match[1];
}

function statusOf(row) {
  // status is live execution; state persists after the native turn becomes idle.
  if (row.status === "busy") return "working";
  if (row.status === "waiting") return "needs-input";
  if (row.status === "idle") {
    if (row.state === "blocked") return "needs-input";
    if (row.state === "done") return "done";
    return "idle";
  }
  return "unavailable";
}

export class ClaudeProvider {
  name = "claude";
  #home;
  #run;
  #endpointFactory;
  #aliases;
  #titleSync;
  #now;
  #usageReader;
  #usageCacheMs;
  #usageCache = null;
  #usageRefresh = null;
  #previewReader = new ClaudePreviewReader();

  constructor({ homeDirectory = os.homedir(), run = defaultRun, endpointFactory, aliasCatalog = null, titleSync = null, now = Date.now, usageReader = null, usageCacheMs = USAGE_CACHE_MS } = {}) {
    this.#home = homeDirectory;
    this.#run = run;
    this.#endpointFactory = endpointFactory ?? ((options) => new ClaudePeerEndpoint(options));
    this.#aliases = aliasCatalog ?? new SessionAliasCatalog(defaultClaudeAliasPath(process.env, homeDirectory));
    this.#titleSync = titleSync ?? new ClaudeTitleSync(path.join(path.dirname(defaultClaudeAliasPath(process.env, homeDirectory)), "claude-title-sync"));
    this.#now = now;
    this.#usageReader = usageReader ?? (() => readClaudeUsage({ homeDirectory: this.#home, now: this.#now }));
    this.#usageCacheMs = usageCacheMs;
  }

  async list({ cwd, includeUsage = false, signal } = {}) {
    if (includeUsage) void this.#refreshUsage();
    const expectedCwd = cwd ? canonical(cwd) : null;
    const aliases = this.#aliases.load();
    const args = ["agents", "--json"];
    if (expectedCwd) args.push("--cwd", expectedCwd);
    const { stdout } = await this.#run(args, { cwd: expectedCwd ?? undefined, ...(signal ? { signal } : {}) });
    const sessions = [];
    for (const row of parseClaudeAgents(stdout)) {
      if (!processAlive(row.pid)) continue;
      let registry;
      try { registry = JSON.parse(fs.readFileSync(path.join(this.#home, ".claude", "sessions", `${row.pid}.json`), "utf8")); } catch { continue; }
      if (registry.pid !== row.pid || registry.sessionId !== row.sessionId || registry.peerProtocol !== 1) continue;
      if (typeof registry.messagingSocketPath !== "string" || !path.isAbsolute(registry.messagingSocketPath)) continue;
      try { if (!fs.lstatSync(registry.messagingSocketPath).isSocket()) continue; } catch { continue; }
      const sessionCwd = canonical(row.cwd);
      const nativeName = row.name ?? registry.name ?? row.id;
      const synced = this.#titleSync.display(row.sessionId, nativeName);
      sessions.push({
        id: `claude:${row.sessionId}`,
        nativeId: row.id,
        sessionId: row.sessionId,
        provider: this.name,
        name: synced?.name ?? aliases.get(`claude:${row.sessionId}`) ?? nativeName,
        nameSync: synced?.nameSync ?? "local",
        cwd: sessionCwd,
        projectCwd: expectedCwd ?? claudeProjectCwd(sessionCwd),
        status: statusOf(row),
        updatedAt: Number(row.startedAt ?? registry.updatedAt ?? 0),
        socketPath: registry.messagingSocketPath,
      });
    }
    return sessions;
  }

  usageSnapshot() {
    return this.#usageCache?.value ?? null;
  }

  preview(session, { signal } = {}) {
    return this.#previewReader.read(session, { homeDirectory: this.#home, signal });
  }

  history(session, options = {}) {
    return readClaudeHistory(session, { ...options, homeDirectory: this.#home });
  }

  async #refreshUsage() {
    const checkedAt = this.#now();
    if (this.#usageCache && checkedAt - this.#usageCache.checkedAt < this.#usageCacheMs) return;
    if (this.#usageRefresh) return this.#usageRefresh;
    this.#usageRefresh = Promise.resolve().then(async () => {
      try {
        const value = await this.#usageReader();
        this.#usageCache = { checkedAt, value: value ?? this.#usageCache?.value ?? null };
      } catch {
        this.#usageCache = { checkedAt, value: this.#usageCache?.value ?? null };
      } finally {
        this.#usageRefresh = null;
      }
    });
    return this.#usageRefresh;
  }

  async create(prompt, { cwd = process.cwd(), model, effort, executionSettings } = {}) {
    const workspace = canonical(cwd);
    const args = ["--bg"];
    if (typeof model === "string" && model.trim()) args.push("--model", model.trim());
    if (typeof effort === "string" && effort.trim()) args.push("--effort", effort.trim());
    if (executionSettings) applyClaudeExecutionSettings(args, executionSettings);
    args.push("--settings", this.#titleSync.settings(), "--append-system-prompt", WAGA_SESSION_INSTRUCTIONS, "--", prompt);
    const { stdout } = await this.#run(args, { cwd: workspace });
    return { provider: this.name, nativeId: parseClaudeBackgroundId(stdout) };
  }

  async archive(session) {
    if (!SHORT_ID.test(session.nativeId)) {
      throw Object.assign(new Error(`Claude background id is invalid: ${session.nativeId}`), { code: "CLAUDE_BACKGROUND_INVALID" });
    }
    const cwd = canonical(session.projectCwd ?? session.cwd ?? process.cwd());
    await this.#run(["rm", session.nativeId], { cwd });
    return { target: session.id, archived: true };
  }

  async rename(session, name) {
    const renamed = name.trim();
    if (this.#titleSync.queue(session.sessionId, renamed)) {
      return { target: session.id, renamed: true, name: renamed, nameSync: "pending" };
    }
    this.#aliases.set(session.id, renamed);
    return { target: session.id, renamed: true, name: renamed, nameSync: "local" };
  }

  async send(session, message, { requestId, onProgress = () => {} }) {
    const envelope = buildPeerEnvelope({ message, requestId, expectsReply: false });
    const endpoint = this.#endpointFactory({ homeDirectory: this.#home, cwd: process.cwd() });
    try {
      await endpoint.start({ socketDirectory: path.dirname(session.socketPath) });
      onProgress({ state: "submitting", delivery: "unknown" });
      const messageId = await endpoint.send(session.socketPath, envelope);
      onProgress({ state: "submitted", delivery: "submitted", messageId });
      const disposition = await endpoint.waitForDisposition(messageId, { timeoutMs: 150 });
      onProgress({ state: disposition.state, delivery: disposition.state, messageId });
      return { target: session.id, requestId, messageId, delivery: disposition.state };
    } finally {
      await endpoint.stop();
    }
  }

  async ask(session, message, { requestId, waitTimeoutMs, replyTimeoutMs, timeoutMs, onProgress = () => {}, onReply = async () => {} }) {
    const fallbackTimeout = timeoutMs ?? 180_000;
    // Peer priority "next" queues natively even while Claude is working.
    const identityTimeout = waitTimeoutMs ?? fallbackTimeout;
    const identityError = Object.assign(new Error("Claude target lookup timed out; message was not sent"), { code: "TARGET_BUSY_TIMEOUT" });
    const sessions = await readBeforeDeadline(signal => this.list({ cwd: session.projectCwd, signal }), {
      deadline: this.#now() + identityTimeout, now: this.#now, error: identityError,
    });
    const current = sessions.find(candidate => candidate.id === session.id && candidate.sessionId === session.sessionId);
    if (!current || !["idle", "working", "needs-input", "done"].includes(current.status)) throw Object.assign(new Error(`Claude target is unavailable: ${session.id}`), { code: "TARGET_UNAVAILABLE" });
    const endpoint = this.#endpointFactory({ homeDirectory: this.#home, cwd: process.cwd() });
    try {
      await endpoint.start({ socketDirectory: path.dirname(current.socketPath) });
      const start = await claudeReplyOffset(current, this.#home);
      const since = Date.now();
      const envelope = buildPeerEnvelope({ message, requestId, expectsReply: true, replyTo: `uds:${endpoint.socketPath}` });
      onProgress({ state: "submitting", target: session.id, delivery: "unknown", fromSocket: endpoint.socketPath });
      const messageId = await endpoint.send(current.socketPath, envelope);
      onProgress({ state: "submitted", target: session.id, delivery: "submitted", messageId });
      const answerTimeout = replyTimeoutMs ?? fallbackTimeout;
      const replyDeadline = this.#now() + answerTimeout;
      const completionError = Object.assign(new Error(`Claude request did not receive a reply within ${answerTimeout}ms`), { code: "REPLY_TIMEOUT" });
      const disposition = await endpoint.waitForDisposition(messageId, { timeoutMs: Math.min(150, answerTimeout) });
      if (disposition.state === "accepted") onProgress({ state: "accepted", target: session.id, delivery: "accepted", messageId });
      const reply = await readBeforeDeadline(signal => waitForClaudeReply(current, requestId, {
        homeDirectory: this.#home, since, start, fromSocket: endpoint.socketPath, signal,
        socketReply: endpoint.waitForReply(current.socketPath, messageId, { timeoutMs: Math.max(1, replyDeadline - this.#now()), requestId }),
      }), {
        deadline: replyDeadline, now: this.#now, error: completionError,
      });
      onProgress({ state: "reply-received", target: session.id, delivery: "accepted", reply: reply.text });
      await onReply(reply.text, { requestId, target: session.id });
      onProgress({ state: "replied", target: session.id, delivery: "accepted" });
      return { target: session.id, requestId, messageId, reply: reply.text, exchangeCount: 1, autoForwarded: false };
    } finally {
      await endpoint.stop();
    }
  }

  async result(record) {
    if (record.kind === "send") {
      const receipt = await readBeforeDeadline(signal => readClaudeReceipt(record, { homeDirectory: this.#home, signal }), {
        deadline: this.#now() + 10_000, now: this.#now,
        error: Object.assign(new Error("Claude receipt lookup timed out"), { code: "RESULT_TIMEOUT" }),
      });
      return receipt ? { state: "accepted", delivery: "accepted", receipt } : {};
    }
    // After the ephemeral reply socket closes, read only an explicitly tagged
    // answer in the target's native transcript; never guess from its last reply.
    const reply = record.reply ?? await readClaudeReply(record.session, record.requestId, {
      homeDirectory: this.#home, since: record.createdAt, fromSocket: record.fromSocket,
    });
    if (!reply) return { state: "result-unknown" };
    return { state: "replied", reply };
  }
}
