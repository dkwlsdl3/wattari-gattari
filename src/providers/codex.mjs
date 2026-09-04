import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { buildPeerEnvelope } from "../bridge/envelope.mjs";
import { CodexAppServerClient } from "../codex-app-server.mjs";
import { WAGA_SESSION_INSTRUCTIONS } from "../managed-session-instructions.mjs";

const execFileAsync = promisify(execFile);
const THREAD_READ_CONCURRENCY = 8;

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

function publicStatus(status) {
  if (status?.type === "active") return "working";
  if (status?.type === "systemError") return "error";
  return "idle";
}

function answerIn(items, turnId) {
  return items.find((entry) => entry.turnId === turnId && entry.item?.type === "agentMessage" && entry.item.text)?.item.text ?? null;
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

  constructor({ run = defaultRun, clientFactory, wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), now = Date.now, daemonCacheMs = 30_000 } = {}) {
    this.#run = run;
    this.#clientFactory = clientFactory ?? ((socketPath) => CodexAppServerClient.connectUnixWebSocket({ socketPath }));
    this.#wait = wait;
    this.#now = now;
    this.#daemonCacheMs = daemonCacheMs;
  }

  async list({ cwd } = {}) {
    return this.#withClient(async (client) => {
      const loadedIds = [];
      let cursor = null;
      do {
        const page = await client.request("thread/loaded/list", { cursor, limit: 100 });
        loadedIds.push(...page.data);
        cursor = page.nextCursor;
      } while (cursor);

      const uniqueIds = [...new Set(loadedIds)];
      const reads = await mapSettled(uniqueIds, THREAD_READ_CONCURRENCY, async (threadId) => {
        const result = await client.request("thread/read", { threadId, includeTurns: false });
        if (!result?.thread || result.thread.id !== threadId) {
          throw Object.assign(new Error(`Codex thread/read response does not match ${threadId}`), { code: "CODEX_THREAD_READ_INVALID" });
        }
        return result.thread;
      });
      const loaded = reads.filter((result) => result.status === "fulfilled").map((result) => result.value);
      if (uniqueIds.length && !loaded.length) throw reads.find((result) => result.status === "rejected").reason;

      const requestedCwd = cwd ? path.resolve(cwd) : null;
      const roots = loaded
        .filter((thread) => !requestedCwd || (thread.cwd && path.resolve(thread.cwd) === requestedCwd))
        .filter(isRootSession);
      const seen = new Set();
      return roots
        .filter((thread) => {
          if (seen.has(thread.id)) return false;
          seen.add(thread.id);
          return true;
        })
        .map(toSession);
    });
  }

  async create(prompt, { cwd = process.cwd() } = {}) {
    const workspace = path.resolve(cwd);
    return this.#withClient(async (client) => {
      const started = await client.request("thread/start", {
        cwd: workspace,
        developerInstructions: WAGA_SESSION_INSTRUCTIONS,
      });
      const threadId = started?.thread?.id;
      if (typeof threadId !== "string" || !threadId) {
        throw Object.assign(new Error("Codex thread/start response is missing its thread id"), { code: "CODEX_THREAD_START_INVALID" });
      }
      const turn = await client.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt, textElements: [] }],
      });
      const turnId = turn?.turn?.id;
      if (typeof turnId !== "string" || !turnId) {
        throw Object.assign(new Error(`Codex turn/start response is missing its turn id for ${threadId}`), { code: "CODEX_TURN_START_INVALID" });
      }
      return { provider: this.name, nativeId: threadId, turnId };
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

  async send(session, message, { requestId }) {
    return this.#withClient(async (client) => {
      const started = await client.request("turn/start", {
        threadId: session.nativeId,
        input: [],
        toolOutput: {
          name: "waga_peer_message",
          namespace: "waga",
          output: buildPeerEnvelope({ message, requestId, expectsReply: false }),
        },
        turnTrigger: "waga-peer",
      });
      return { target: session.id, requestId, turnId: started.turn.id, delivery: "submitted" };
    });
  }

  async ask(session, message, { requestId, waitTimeoutMs, replyTimeoutMs, timeoutMs, untilIdle = false, onProgress = () => {} }) {
    return this.#withClient(async (client) => {
      const fallbackTimeout = timeoutMs ?? 180_000;
      const busyTimeout = waitTimeoutMs ?? fallbackTimeout;
      const answerTimeout = replyTimeoutMs ?? fallbackTimeout;
      const waitDeadline = this.#now() + busyTimeout;
      let waiting = false;
      let pollIntervalMs = 250;
      while (true) {
        const { thread } = await client.request("thread/read", { threadId: session.nativeId, includeTurns: false });
        if (thread.status?.type === "systemError") throw Object.assign(new Error(`Codex target is in systemError state: ${session.id}`), { code: "TARGET_ERROR" });
        if (thread.status?.type !== "active") break;
        if (!waiting) { onProgress({ state: "waiting", target: session.id }); waiting = true; }
        if (this.#now() >= waitDeadline) throw Object.assign(new Error(`Codex target stayed busy for ${busyTimeout}ms`), { code: "TARGET_BUSY_TIMEOUT" });
        await this.#wait(Math.min(pollIntervalMs, Math.max(1, waitDeadline - this.#now())));
        pollIntervalMs = Math.min(2_000, pollIntervalMs * 2);
      }

      const started = await client.request("turn/start", {
        threadId: session.nativeId,
        input: [],
        toolOutput: {
          name: "waga_peer_message",
          namespace: "waga",
          output: buildPeerEnvelope({ message, requestId, expectsReply: true }),
        },
        turnTrigger: "waga-peer",
      });
      onProgress({ state: "submitted", target: session.id });
      const turnId = started.turn.id;
      const replyDeadline = this.#now() + answerTimeout;
      while (this.#now() < replyDeadline) {
        if (untilIdle) {
          const turns = await client.request("thread/turns/list", {
            threadId: session.nativeId,
            limit: 100,
            sortDirection: "desc",
            itemsView: "summary",
          });
          const turn = turns.data.find((candidate) => candidate.id === turnId);
          if (turn?.status === "failed" || turn?.status === "interrupted") {
            throw Object.assign(new Error(`Codex turn ${turn.status}: ${turnId}`), { code: "TARGET_ERROR" });
          }
          if (turn?.status === "completed") {
            const page = await client.request("thread/items/list", { threadId: session.nativeId, turnId, limit: 100, sortDirection: "desc" });
            const reply = answerIn(page.data, turnId);
            if (!reply) throw Object.assign(new Error(`Codex turn completed without a reply: ${turnId}`), { code: "REPLY_MISSING" });
            onProgress({ state: "replied", target: session.id });
            return { target: session.id, requestId, turnId, reply, exchangeCount: 1, autoForwarded: false };
          }
        } else {
          const page = await client.request("thread/items/list", { threadId: session.nativeId, turnId, limit: 100, sortDirection: "desc" });
          const reply = answerIn(page.data, turnId);
          if (reply) {
            onProgress({ state: "replied", target: session.id });
            return { target: session.id, requestId, turnId, reply, exchangeCount: 1, autoForwarded: false };
          }
        }
        const { thread } = await client.request("thread/read", { threadId: session.nativeId, includeTurns: false });
        if (thread.status?.type === "systemError") throw Object.assign(new Error(`Codex turn failed: ${turnId}`), { code: "TARGET_ERROR" });
        await this.#wait(Math.min(250, Math.max(1, replyDeadline - this.#now())));
      }
      const action = untilIdle ? "complete" : "reply";
      throw Object.assign(new Error(`Codex session did not ${action} within ${answerTimeout}ms`), { code: "REPLY_TIMEOUT" });
    });
  }

  async daemonInfo({ start = false, fresh = false } = {}) {
    if (!fresh && this.#daemonCache && this.#now() - this.#daemonCache.observedAt < this.#daemonCacheMs) {
      return this.#daemonCache.value;
    }
    let result = parseDaemonVersion((await this.#run(["app-server", "daemon", "version"])).stdout);
    if (result.status !== "running" && start) {
      await this.#run(["app-server", "daemon", "start"]);
      result = parseDaemonVersion((await this.#run(["app-server", "daemon", "version"])).stdout);
    }
    if (result.status === "running" && typeof result.socketPath === "string" && path.isAbsolute(result.socketPath)) {
      this.#daemonCache = { value: result, observedAt: this.#now() };
    } else {
      this.#daemonCache = null;
    }
    return result;
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
      return await operation(client);
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
