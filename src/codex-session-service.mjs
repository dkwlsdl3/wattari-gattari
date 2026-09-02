import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";

import { CodexAppServerClient } from "./codex-app-server.mjs";
import { ManagedThreadCatalog } from "./managed-thread-catalog.mjs";
import { MANAGED_DEVELOPER_INSTRUCTIONS } from "./peer-protocol.mjs";

const THREAD_SOURCE = "waga";
const LEGACY_THREAD_SOURCES = new Set(["agent-bus"]);
const PAGE_SIZE = 100;
export { MANAGED_DEVELOPER_INSTRUCTIONS } from "./peer-protocol.mjs";

function canonical(input) {
  const resolved = path.resolve(input);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

class CodexSessionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function displayName(thread) {
  const text = thread.name || thread.preview || thread.id;
  return text.length > 42 ? `${text.slice(0, 41)}…` : text;
}

function displayStatus(thread, runtime = null) {
  switch (runtime?.status?.type ?? thread.status?.type) {
    case "notLoaded": return "Sleeping";
    case "active": return "Working";
    case "idle": return "Awaiting input";
    case "systemError": return "Error";
    default: return "Error";
  }
}

function publicSession(thread, runtime = null, rateLimits = null) {
  const status = displayStatus(thread, runtime);
  return {
    id: `codex:${thread.id}`,
    threadId: thread.id,
    provider: "codex",
    name: displayName(thread),
    cwd: thread.cwd,
    status,
    lastActivity: thread.preview || "아직 대화가 없습니다",
    updatedAt: thread.updatedAt,
    routable: status === "Working" || status === "Awaiting input",
    workingSince: status === "Working" ? runtime?.workingSince ?? null : null,
    activeTurnId: status === "Working" ? runtime?.activeTurnId ?? null : null,
    model: runtime?.model ?? null,
    reasoningEffort: runtime?.reasoningEffort ?? null,
    serviceTier: runtime?.serviceTier ?? null,
    gitBranch: thread.gitInfo?.branch ?? runtime?.gitInfo?.branch ?? null,
    gitSha: thread.gitInfo?.sha ?? runtime?.gitInfo?.sha ?? null,
    tokenUsage: runtime?.tokenUsage ?? null,
    rateLimits,
  };
}

export class CodexSessionService extends EventEmitter {
  #client;
  #clientFactory;
  #cwd;
  #connected = false;
  #runtime = new Map();
  #rateLimits = null;

  constructor({
    cwd = process.cwd(),
    socketPath,
    catalogPath,
    clientFactory = (options) => CodexAppServerClient.connectUnixWebSocket(options),
  } = {}) {
    super();
    this.#cwd = canonical(cwd);
    this.socketPath = socketPath;
    this.#clientFactory = clientFactory;
    this.catalog = new ManagedThreadCatalog(catalogPath);
  }

  async connect() {
    if (this.#connected) return;
    this.#client = await this.#clientFactory({
      cwd: this.#cwd,
      socketPath: this.socketPath,
      onNotification: (notification) => this.#handleNotification(notification),
    });
    try {
      await this.#client.initialize();
      this.#connected = true;
      await this.#readRateLimits();
    } catch (error) {
      await this.#client.close().catch(() => {});
      this.#client = null;
      throw error;
    }
  }

  async listSessions() {
    this.#assertConnected();
    const active = await this.#listThreads(false);
    const activeIds = new Set(active.map((thread) => thread.id));
    const missingIds = [...this.catalog.read()].filter((threadId) => !activeIds.has(threadId));
    if (missingIds.length) {
      await this.#listThreads(true);
      for (const threadId of missingIds) this.catalog.remove(threadId);
    }
    return active
      .map((thread) => publicSession(thread, this.#runtime.get(thread.id), this.#rateLimits))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async renameSession(threadId, name) {
    this.#assertConnected();
    if (typeof name !== "string" || !name.trim()) {
      throw new CodexSessionError("INVALID_NAME", "세션 이름이 필요합니다");
    }
    if (!await this.#findSession(threadId)) {
      throw new CodexSessionError("SESSION_NOT_FOUND", `관리 세션을 찾을 수 없습니다: ${threadId}`);
    }
    await this.#client.request("thread/name/set", { threadId, name: name.trim() });
    this.emit("changed", { method: "waga/session-renamed", params: { threadId } });
  }

  async stopSession(threadId) {
    this.#assertConnected();
    if (!await this.#findSession(threadId)) {
      throw new CodexSessionError("SESSION_NOT_FOUND", `관리 세션을 찾을 수 없습니다: ${threadId}`);
    }
    const turns = await this.#client.request("thread/turns/list", {
      threadId,
      limit: 20,
      sortDirection: "desc",
      itemsView: "summary",
    });
    const activeTurn = turns.data.find((turn) => turn.status === "inProgress");
    if (activeTurn) await this.#client.request("turn/interrupt", { threadId, turnId: activeTurn.id });
    await this.#client.request("thread/archive", { threadId });
    this.#runtime.delete(threadId);
    this.catalog.remove(threadId);
    this.emit("changed", { method: "waga/session-stopped", params: { threadId } });
  }

  async detach() {
    if (!this.#client) return;
    const client = this.#client;
    this.#client = null;
    this.#connected = false;
    await client.close();
  }

  async #listThreads(archived) {
    const threads = [];
    const managedIds = this.catalog.read();
    let cursor = null;
    do {
      const page = await this.#client.request("thread/list", {
        archived,
        cursor,
        cwd: this.#cwd,
        limit: PAGE_SIZE,
        sortDirection: "desc",
        sortKey: "updated_at",
        useStateDbOnly: true,
      });
      for (const thread of page.data) {
        const isWagaThread = thread.threadSource === THREAD_SOURCE || LEGACY_THREAD_SOURCES.has(thread.threadSource);
        if (!archived && isWagaThread) this.catalog.record(thread.id);
        if (isWagaThread || managedIds.has(thread.id)) threads.push(thread);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return threads;
  }

  async #findSession(threadId) {
    return (await this.listSessions()).find((session) => session.threadId === threadId) ?? null;
  }

  #runtimeFor(threadId) {
    const current = this.#runtime.get(threadId) ?? {};
    this.#runtime.set(threadId, current);
    return current;
  }

  #handleNotification(notification) {
    const { method, params = {} } = notification ?? {};
    if (method === "thread/started" && params.thread?.id && canonical(params.thread.cwd) === this.#cwd) {
      this.catalog.record(params.thread.id);
      this.#runtimeFor(params.thread.id).status = params.thread.status;
    } else if (method === "thread/status/changed" && params.threadId && params.status) {
      this.#runtimeFor(params.threadId).status = params.status;
    } else if (method === "turn/started" && params.threadId && params.turn?.id) {
      this.catalog.record(params.threadId);
      Object.assign(this.#runtimeFor(params.threadId), {
        status: { type: "active", activeFlags: [] },
        activeTurnId: params.turn.id,
        workingSince: Number.isFinite(params.turn.startedAt) ? params.turn.startedAt * 1_000 : Date.now(),
      });
    } else if (method === "turn/completed" && params.threadId) {
      Object.assign(this.#runtimeFor(params.threadId), {
        status: { type: "idle" },
        activeTurnId: null,
        workingSince: null,
      });
    } else if (method === "thread/tokenUsage/updated" && params.threadId) {
      this.#runtimeFor(params.threadId).tokenUsage = params.tokenUsage;
    } else if (method === "account/rateLimits/updated" && params.rateLimits) {
      this.#rateLimits = { ...(this.#rateLimits ?? {}), ...params.rateLimits };
    }
    this.emit("changed", notification);
  }

  async #readRateLimits() {
    try {
      const result = await this.#client.request("account/rateLimits/read", {}, { signal: AbortSignal.timeout(2_000) });
      this.#rateLimits = result.rateLimits ?? null;
    } catch {
      // API-key and non-OpenAI providers may not expose ChatGPT rate limits.
    }
  }

  #assertConnected() {
    if (!this.#connected) throw new CodexSessionError("SERVICE_NOT_CONNECTED", "Codex daemon에 연결되지 않았습니다");
  }
}
