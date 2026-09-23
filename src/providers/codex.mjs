import { execFile } from "node:child_process";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";

import { buildPeerEnvelope } from "../bridge/envelope.mjs";
import { readBeforeDeadline } from "../bridge/deadline.mjs";
import { CodexAppServerClient } from "../codex-app-server.mjs";
import { applyCodexExecutionMode, CODEX_EXECUTION_MODES, isCodexExecutionMode } from "../codex-execution.mjs";
import { applyCodexExecutionSettings } from "../provider-execution.mjs";
import { EventLog } from "../event-log.mjs";
import { WAGA_SESSION_INSTRUCTIONS } from "../managed-session-instructions.mjs";
import { messageText, previewText } from "../session-preview.mjs";

const execFileAsync = promisify(execFile);
const THREAD_READ_CONCURRENCY = 8;
const USAGE_CACHE_MS = 5 * 60_000;
const WEEKLY_WINDOW_MINS = 7 * 24 * 60;

async function defaultRun(args) {
  return execFileAsync("codex", args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 30_000 });
}

export function parseDaemonVersion(stdout) {
  let value;
  try { value = JSON.parse(stdout); } catch (cause) {
    throw Object.assign(new Error("Codex daemon version did not return valid JSON", { cause }), { code: "CODEX_DAEMON_INVALID" });
  }
  if (!value || typeof value.status !== "string") throw Object.assign(new Error("Codex daemon version JSON is missing status"), { code: "CODEX_DAEMON_INVALID" });
  return value;
}

export function parseCodexUsage(result, observedAt = Date.now()) {
  const rateLimits = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  const windows = [rateLimits?.primary, rateLimits?.secondary]
    .filter((window) => Number.isFinite(window?.usedPercent));
  const window = windows.find((candidate) => candidate.windowDurationMins === WEEKLY_WINDOW_MINS)
    ?? windows.toSorted((left, right) => (right.windowDurationMins ?? 0) - (left.windowDurationMins ?? 0))[0];
  if (!window) return null;
  const usedPercent = Math.max(0, Math.min(100, Math.round(window.usedPercent)));
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    windowDurationMins: Number.isFinite(window.windowDurationMins) ? window.windowDurationMins : null,
    resetsAt: Number.isFinite(window.resetsAt) ? window.resetsAt : null,
    observedAt,
  };
}

function publicStatus(status) {
  if (status?.type === "active") return status.activeFlags?.some((flag) => ["waitingOnApproval", "waitingOnUserInput"].includes(flag)) ? "needs-input" : "working";
  if (status?.type === "systemError") return "error";
  return status?.type === "idle" ? "idle" : "unavailable";
}

function answerIn(items, turnId) {
  return items.find((entry) => entry.turnId === turnId && entry.item?.type === "agentMessage" && entry.item.text)?.item.text ?? null;
}

// Cursor shapes follow the installed App Server's generated v2 schema.
async function* pages(read, method, params) {
  const seen = new Set();
  let cursor;
  do {
    const page = await read(method, { ...params, ...(cursor ? { cursor } : {}) });
    if (!Array.isArray(page?.data) || (page.nextCursor != null && (typeof page.nextCursor !== "string" || !page.nextCursor))) {
      throw Object.assign(new Error(`Invalid Codex page: ${method}`), { code: "CODEX_PAGE_INVALID" });
    }
    yield page.data;
    cursor = page.nextCursor;
    if (cursor && seen.has(cursor)) throw Object.assign(new Error(`Repeated Codex cursor: ${method}`), { code: "CODEX_PAGE_INVALID" });
    if (cursor) seen.add(cursor);
  } while (cursor);
}

async function findInPages(read, method, params, match) {
  for await (const data of pages(read, method, params)) {
    const value = match(data);
    if (value) return value;
  }
  return null;
}

async function mapSettled(values, concurrency, operation) {
  const results = new Array(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: "fulfilled", value: await operation(values[index]) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}

function isRootSession(thread) {
  return !thread.ephemeral && !thread.parentThreadId;
}

function toSession(thread) {
  return {
    id: `codex:${thread.id}`,
    nativeId: thread.id,
    sessionId: thread.sessionId ?? thread.id,
    provider: "codex",
    name: thread.name ?? thread.preview?.split("\n", 1)[0] ?? thread.id,
    cwd: thread.cwd,
    status: publicStatus(thread.status),
    updatedAt: Number(thread.updatedAt ?? 0) * 1_000,
  };
}

export class CodexProvider {
  name = "codex";
  #run;
  #clientFactory;
  #wait;
  #now;
  #daemonCacheMs;
  #daemonCache = null;
  #usageCacheMs;
  #usageTimeoutMs;
  #usageCache = null;
  #usageRefresh = null;
  #eventLog;
  #loadedIds = null;

  constructor({ run = defaultRun, clientFactory, wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), now = Date.now, daemonCacheMs = 30_000, usageCacheMs = USAGE_CACHE_MS, usageTimeoutMs = 1_000, eventLog = new EventLog() } = {}) {
    this.#run = run;
    this.#clientFactory = clientFactory ?? ((socketPath) => CodexAppServerClient.connectUnixWebSocket({ socketPath }));
    this.#wait = wait;
    this.#now = now;
    this.#daemonCacheMs = daemonCacheMs;
    this.#usageCacheMs = usageCacheMs;
    this.#usageTimeoutMs = usageTimeoutMs;
    this.#eventLog = eventLog;
  }

  async list({ cwd, includeUsage = false } = {}) {
    return this.#withClient(async (client) => {
      if (includeUsage) void this.#refreshUsage();
      const loadedIds = [];
      for await (const data of pages((...args) => client.request(...args), "thread/loaded/list", { cursor: null, limit: 100 })) loadedIds.push(...data);

      const uniqueIds = [...new Set(loadedIds)].sort();
      this.#recordLoadedIds(uniqueIds);
      const reads = await mapSettled(uniqueIds, THREAD_READ_CONCURRENCY, async (threadId) => {
        const result = await client.request("thread/read", { threadId, includeTurns: false });
        if (!result?.thread || result.thread.id !== threadId) {
          throw Object.assign(new Error(`Codex thread/read response does not match ${threadId}`), { code: "CODEX_THREAD_READ_INVALID" });
        }
        return result.thread;
      });
      const loaded = reads.filter((result) => result.status === "fulfilled").map((result) => result.value);
      // A partial read must not authorize the dock to close missing session views.
      const failed = reads.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;

      const requestedCwd = cwd ? path.resolve(cwd) : null;
      const roots = loaded
        .filter((thread) => !requestedCwd || (thread.cwd && path.resolve(thread.cwd) === requestedCwd))
        .filter(isRootSession);
      const seen = new Set();
      const sessions = roots
        .filter((thread) => {
          if (seen.has(thread.id)) return false;
          seen.add(thread.id);
          return true;
        })
        .map(toSession);
      return sessions;
    });
  }

  usageSnapshot() {
    return this.#usageCache?.value ?? null;
  }

  async preview(session, { signal } = {}) {
    // Unlike session operations, preview must never start a stopped daemon.
    signal?.throwIfAborted();
    const daemon = await this.daemonInfo();
    this.#assertDaemonAvailable(daemon);
    signal?.throwIfAborted();
    const client = await this.#clientFactory(daemon.socketPath);
    try {
      const boundedSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(3_000)]);
      await client.initialize({ signal: boundedSignal });
      const result = { input: "", output: "", limited: false };
      let count = 0;
      for await (const data of pages((method, params) => client.request(method, params, { signal: boundedSignal }),
        "thread/items/list", { threadId: session.nativeId, limit: 50, sortDirection: "desc" })) {
        for (const { item } of data) {
          if (item?.type === "userMessage" && !result.input) result.input = messageText(item.content) || "[텍스트 없는 입력]";
          if (item?.type === "agentMessage" && !result.output) result.output = previewText(item.text);
          if (result.input && result.output) return result;
        }
        if (++count === 3) { result.limited = true; break; }
      }
      return result;
    } finally { await client.close(); }
  }

  async #refreshUsage() {
    const checkedAt = this.#now();
    if (this.#usageCache && checkedAt - this.#usageCache.checkedAt < this.#usageCacheMs) return;
    if (this.#usageRefresh) return this.#usageRefresh;
    this.#usageRefresh = Promise.resolve().then(async () => {
      try {
        // An independent client lets discovery close promptly without cancelling the quota read.
        const result = await this.#withClient((client) => readBeforeDeadline((signal) => client.request("account/rateLimits/read", undefined, { signal }), {
          deadline: checkedAt + this.#usageTimeoutMs, now: this.#now,
          error: Object.assign(new Error("Codex usage read timed out"), { code: "CODEX_USAGE_TIMEOUT" }),
        }));
        const value = parseCodexUsage(result, checkedAt);
        this.#usageCache = { checkedAt, value: value ?? this.#usageCache?.value ?? null };
      } catch {
        this.#usageCache = { checkedAt, value: this.#usageCache?.value ?? null };
      } finally {
        this.#usageRefresh = null;
      }
    });
    return this.#usageRefresh;
  }

  #recordLoadedIds(sessionIds) {
    if (this.#loadedIds === null) {
      this.#eventLog.record("codex_loaded_snapshot", { sessionIds });
      this.#loadedIds = sessionIds;
      return;
    }
    const previous = new Set(this.#loadedIds);
    const current = new Set(sessionIds);
    const addedSessionIds = sessionIds.filter((id) => !previous.has(id));
    const removedSessionIds = this.#loadedIds.filter((id) => !current.has(id));
    if (addedSessionIds.length || removedSessionIds.length) {
      this.#eventLog.record("codex_loaded_changed", { addedSessionIds, removedSessionIds, sessionIds });
    }
    this.#loadedIds = sessionIds;
  }

  async create(prompt, { cwd = process.cwd(), model, effort, executionMode, executionSettings } = {}) {
    const workspace = path.resolve(cwd);
    return this.#withClient(async (client) => {
      const threadBase = {
        cwd: workspace,
        developerInstructions: WAGA_SESSION_INSTRUCTIONS,
      };
      const threadStart = executionSettings
        ? applyCodexExecutionSettings(threadBase, executionSettings, "thread", { cwd: workspace })
        : applyCodexExecutionMode(threadBase, executionMode, "thread");
      if (typeof model === "string" && model.trim()) threadStart.model = model.trim();
      const started = await client.request("thread/start", threadStart);
      const threadId = started?.thread?.id;
      if (typeof threadId !== "string" || !threadId) {
        throw Object.assign(new Error("Codex thread/start response is missing its thread id"), { code: "CODEX_THREAD_START_INVALID" });
      }
      const turnBase = {
        threadId,
        input: [{ type: "text", text: prompt, textElements: [] }],
      };
      const turnStart = executionSettings
        ? applyCodexExecutionSettings(turnBase, executionSettings, "turn", { cwd: workspace })
        : applyCodexExecutionMode(turnBase, executionMode, "turn");
      if (typeof model === "string" && model.trim()) turnStart.model = model.trim();
      if (typeof effort === "string" && effort.trim()) turnStart.effort = effort.trim();
      const turn = await client.request("turn/start", turnStart);
      const turnId = turn?.turn?.id;
      if (typeof turnId !== "string" || !turnId) {
        throw Object.assign(new Error(`Codex turn/start response is missing its turn id for ${threadId}`), { code: "CODEX_TURN_START_INVALID" });
      }
      return { provider: this.name, nativeId: threadId, turnId };
    });
  }

  async prepareNativeSession(session, executionMode) {
    if (!isCodexExecutionMode(executionMode)) {
      throw Object.assign(new TypeError("Unknown Codex execution mode"), { code: "CODEX_EXECUTION_MODE_INVALID" });
    }
    return this.#withClient(async (client, daemon) => {
      const threadId = session.nativeId;
      let approvalPolicy;
      let sandboxPolicy;
      if (executionMode === CODEX_EXECUTION_MODES.YOLO) {
        approvalPolicy = "never";
        sandboxPolicy = { type: "dangerFullAccess" };
      } else {
        const config = (await client.request("config/read", {}))?.config;
        if (!config || typeof config !== "object") {
          throw Object.assign(new Error("Codex config/read did not return configuration"), { code: "CODEX_CONFIG_INVALID" });
        }
        approvalPolicy = config.approval_policy ?? "on-request";
        const sandbox = config.sandbox_mode ?? "workspace-write";
        if (sandbox === "danger-full-access") sandboxPolicy = { type: "dangerFullAccess" };
        else if (sandbox === "read-only") sandboxPolicy = { type: "readOnly", networkAccess: false };
        else if (sandbox === "workspace-write") {
          const settings = config.sandbox_workspace_write ?? {};
          sandboxPolicy = {
            type: "workspaceWrite",
            writableRoots: settings.writable_roots ?? [],
            networkAccess: settings.network_access ?? false,
            excludeTmpdirEnvVar: settings.exclude_tmpdir_env_var ?? false,
            excludeSlashTmp: settings.exclude_slash_tmp ?? false,
          };
        } else {
          throw Object.assign(new Error(`Unsupported Codex sandbox mode: ${sandbox}`), { code: "CODEX_CONFIG_INVALID" });
        }
      }
      await client.request("thread/settings/update", { threadId, approvalPolicy, sandboxPolicy });
      const resumed = await client.request("thread/resume", { threadId, excludeTurns: true });
      if (resumed?.thread?.id !== threadId || !isDeepStrictEqual(resumed.approvalPolicy, approvalPolicy)
          || resumed.sandbox?.type !== sandboxPolicy.type
          || ("networkAccess" in sandboxPolicy && resumed.sandbox?.networkAccess !== sandboxPolicy.networkAccess)) {
        throw Object.assign(new Error("Codex thread permissions did not match the selected execution mode"), { code: "CODEX_PERMISSION_MISMATCH" });
      }
      return { socketPath: daemon.socketPath };
    });
  }

  async archive(session) {
    return this.#withClient(async (client) => {
      await client.request("thread/archive", { threadId: session.nativeId });
      return { target: session.id, archived: true };
    });
  }

  async rename(session, name) {
    return this.#withClient(async (client) => {
      await client.request("thread/name/set", { threadId: session.nativeId, name: name.trim() });
      return { target: session.id, renamed: true, name: name.trim() };
    });
  }

  async send(session, message, { requestId, waitTimeoutMs = 30 * 60_000, onProgress = () => {} }) {
    return this.#withClient(async (client) => {
      await this.#waitUntilIdle(client, session, waitTimeoutMs, onProgress);
      const envelope = buildPeerEnvelope({ message, requestId, expectsReply: false });
      onProgress({ state: "submitting", target: session.id, delivery: "unknown" });
      const started = await client.request("turn/start", {
        threadId: session.nativeId,
        input: [],
        toolOutput: {
          name: "waga_peer_message",
          namespace: "waga",
          output: envelope,
        },
        turnTrigger: "waga-peer",
      });
      this.#assertTurnId(started);
      onProgress({ state: "submitted", target: session.id, delivery: "accepted", turnId: started.turn.id });
      return { target: session.id, requestId, turnId: started.turn.id, delivery: "accepted" };
    });
  }

  async ask(session, message, { requestId, waitTimeoutMs, replyTimeoutMs, timeoutMs, untilIdle = false, onProgress = () => {} }) {
    return this.#withClient(async (client) => {
      const fallbackTimeout = timeoutMs ?? 180_000;
      const busyTimeout = waitTimeoutMs ?? fallbackTimeout;
      const answerTimeout = replyTimeoutMs ?? fallbackTimeout;
      const read = (method, params, deadline, error) => readBeforeDeadline(
        (signal) => client.request(method, params, { signal }), { deadline, now: this.#now, error },
      );
      const envelope = buildPeerEnvelope({ message, requestId, expectsReply: true });
      await this.#waitUntilIdle(client, session, busyTimeout, onProgress);
      onProgress({ state: "submitting", target: session.id, delivery: "unknown" });
      const started = await client.request("turn/start", {
        threadId: session.nativeId,
        input: [],
        toolOutput: {
          name: "waga_peer_message",
          namespace: "waga",
          output: envelope,
        },
        turnTrigger: "waga-peer",
      });
      this.#assertTurnId(started);
      const turnId = started.turn.id;
      onProgress({ state: "submitted", target: session.id, delivery: "accepted", turnId });
      const replyDeadline = this.#now() + answerTimeout;
      const replyError = Object.assign(new Error(`Codex session did not ${untilIdle ? "complete" : "reply"} within ${answerTimeout}ms`), { code: "REPLY_TIMEOUT" });
      const replyRead = (method, params) => read(method, params, replyDeadline, replyError);
      const findReply = () => findInPages(replyRead, "thread/items/list", { threadId: session.nativeId, turnId, limit: 100, sortDirection: "desc" }, (data) => answerIn(data, turnId));
      while (this.#now() < replyDeadline) {
        if (untilIdle) {
          const turn = await findInPages(replyRead, "thread/turns/list", {
            threadId: session.nativeId,
            limit: 100,
            sortDirection: "desc",
            itemsView: "summary",
          }, (data) => data.find((candidate) => candidate.id === turnId));
          if (turn?.status === "failed" || turn?.status === "interrupted") {
            throw Object.assign(new Error(`Codex turn ${turn.status}: ${turnId}`), { code: "TARGET_ERROR" });
          }
          if (turn?.status === "completed") {
            const reply = await findReply();
            if (!reply) throw Object.assign(new Error(`Codex turn completed without a reply: ${turnId}`), { code: "REPLY_MISSING" });
            onProgress({ state: "replied", target: session.id, delivery: "accepted" });
            return { target: session.id, requestId, turnId, reply, exchangeCount: 1, autoForwarded: false };
          }
        } else {
          const reply = await findReply();
          if (reply) {
            onProgress({ state: "replied", target: session.id, delivery: "accepted" });
            return { target: session.id, requestId, turnId, reply, exchangeCount: 1, autoForwarded: false };
          }
        }
        const { thread } = await read("thread/read", { threadId: session.nativeId, includeTurns: false }, replyDeadline, replyError);
        if (thread.status?.type === "systemError") throw Object.assign(new Error(`Codex turn failed: ${turnId}`), { code: "TARGET_ERROR" });
        await this.#wait(Math.min(250, Math.max(1, replyDeadline - this.#now())));
      }
      throw replyError;
    });
  }

  #assertTurnId(started) {
    if (typeof started?.turn?.id !== "string" || !started.turn.id) {
      throw Object.assign(new Error("Codex submission outcome is unknown: missing turn ID"), { code: "CODEX_TURN_START_INVALID" });
    }
  }

  async #waitUntilIdle(client, session, timeoutMs, onProgress) {
    const read = (method, params, deadline, error) => readBeforeDeadline(
      (signal) => client.request(method, params, { signal }), { deadline, now: this.#now, error },
    );
    const waitDeadline = this.#now() + timeoutMs;
    const busyError = Object.assign(new Error(`Codex target stayed busy for ${timeoutMs}ms`), { code: "TARGET_BUSY_TIMEOUT" });
    let waiting = false;
    let pollIntervalMs = 250;
    while (true) {
      const { thread } = await read("thread/read", { threadId: session.nativeId, includeTurns: false }, waitDeadline, busyError);
      if (thread.status?.type === "systemError") throw Object.assign(new Error(`Codex target is in systemError state: ${session.id}`), { code: "TARGET_ERROR" });
      if (!["active", "idle"].includes(thread.status?.type)) throw Object.assign(new Error(`Codex target is unavailable: ${session.id}`), { code: "TARGET_UNAVAILABLE" });
      if (thread.status?.type !== "active") break;
      if (!waiting) { onProgress({ state: "waiting", target: session.id, delivery: "not-sent" }); waiting = true; }
      await this.#wait(Math.min(pollIntervalMs, Math.max(1, waitDeadline - this.#now())));
      pollIntervalMs = Math.min(2_000, pollIntervalMs * 2);
    }

  }

  async result(record) {
    if (!record.turnId) return { state: "result-unknown" };
    // Read-only recovery must not start or resume a native daemon/session.
    const daemon = await this.daemonInfo();
    this.#assertDaemonAvailable(daemon);
    const client = await this.#clientFactory(daemon.socketPath);
    try {
      await client.initialize();
      const deadline = this.#now() + 10_000;
      const error = Object.assign(new Error("Codex result lookup timed out"), { code: "RESULT_TIMEOUT" });
      const read = (method, params) => readBeforeDeadline(signal => client.request(method, params, { signal }), { deadline, now: this.#now, error });
      const turn = await findInPages(read, "thread/turns/list", {
        threadId: record.session.nativeId, limit: 100, sortDirection: "desc", itemsView: "summary",
      }, data => data.find(candidate => candidate.id === record.turnId));
      if (!turn) return { state: "result-unknown" };
      if (["failed", "interrupted"].includes(turn.status)) return { state: turn.status };
      if (record.untilIdle && turn.status !== "completed") return { state: "working" };
      const reply = await findInPages(read, "thread/items/list", {
        threadId: record.session.nativeId, turnId: record.turnId, limit: 100, sortDirection: "desc",
      }, data => answerIn(data, record.turnId));
      return reply ? { state: "replied", reply } : { state: turn.status === "completed" ? "reply-missing" : "working" };
    } finally { await client.close(); }
  }

  async daemonInfo({ start = false, fresh = false } = {}) {
    if (!fresh && this.#daemonCache && this.#now() - this.#daemonCache.observedAt < this.#daemonCacheMs) {
      return this.#daemonCache.value;
    }
    let result = await this.#readDaemonVersion();
    if (result.status !== "running" && start) {
      await this.#run(["app-server", "daemon", "start"]);
      result = await this.#readDaemonVersion();
    }
    if (result.status === "running" && typeof result.socketPath === "string" && path.isAbsolute(result.socketPath)) {
      this.#daemonCache = { value: result, observedAt: this.#now() };
    } else {
      this.#daemonCache = null;
    }
    return result;
  }

  // `daemon version` reads the control socket, so a stopped daemon has no JSON form:
  // codex 0.152.1-0.155.0 exit non-zero with a plain connect error whether the socket
  // file is stale or missing entirely (2026-09-18 measured). A non-zero exit is the
  // only signal for "stopped"; a successful run still must match the JSON contract.
  async #readDaemonVersion() {
    let stdout;
    try { ({ stdout } = await this.#run(["app-server", "daemon", "version"])); }
    catch { return { status: "stopped" }; }
    return parseDaemonVersion(stdout);
  }

  async #withClient(operation) {
    let daemon = await this.daemonInfo({ start: true });
    this.#assertDaemonAvailable(daemon);
    let client;
    try {
      client = await this.#clientFactory(daemon.socketPath);
    } catch {
      this.#daemonCache = null;
      daemon = await this.daemonInfo({ start: true, fresh: true });
      this.#assertDaemonAvailable(daemon);
      client = await this.#clientFactory(daemon.socketPath);
    }
    try {
      await client.initialize();
      return await operation(client, daemon);
    } finally {
      await client.close();
    }
  }

  #assertDaemonAvailable(daemon) {
    if (daemon.status !== "running" || typeof daemon.socketPath !== "string" || !path.isAbsolute(daemon.socketPath)) {
      throw Object.assign(new Error("Codex native app-server daemon is unavailable"), { code: "CODEX_DAEMON_UNAVAILABLE" });
    }
  }
}
