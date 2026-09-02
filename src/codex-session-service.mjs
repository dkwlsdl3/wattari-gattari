import { EventEmitter } from "node:events";

import {
  APPROVAL_GATE_PATH,
  APPROVAL_HOOK_MATCHER,
  CodexAppServerClient,
} from "./codex-app-server.mjs";
import { ManagedThreadCatalog } from "./managed-thread-catalog.mjs";

const THREAD_SOURCE = "waga";
const LEGACY_THREAD_SOURCES = new Set(["agent-bus"]);
const MAX_PAGE_SIZE = 100;
const TRANSCRIPT_ITEM_PAGE_SIZE = 100;

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

function displayStatus(thread, archived) {
  if (archived) return "Stopped";
  switch (thread.status?.type) {
    case "notLoaded": return "Sleeping";
    case "active": return "Working";
    case "idle": return "Awaiting input";
    case "systemError": return "Error";
    default: return "Error";
  }
}

function publicSession(thread, archived = false, runtime = null, rateLimits = null) {
  const effectiveThread = runtime?.status ? { ...thread, status: runtime.status } : thread;
  const status = displayStatus(effectiveThread, archived);
  const tokenUsage = runtime?.tokenUsage ?? null;
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
    tokenUsage,
    rateLimits,
  };
}

function textFromUserMessage(item) {
  return item.content
    .filter((content) => content.type === "text" && content.text)
    .map((content) => content.text)
    .join("\n");
}

function publicMessage(entry) {
  const item = entry.item;
  if (item.type === "userMessage") {
    return { id: item.id, turnId: entry.turnId, role: "user", text: textFromUserMessage(item) };
  }
  if (item.type === "agentMessage") {
    return { id: item.id, turnId: entry.turnId, role: "agent", text: item.text };
  }
  return null;
}

function mergeMessages(existing, incoming, { prepend = false } = {}) {
  const incomingById = new Map(incoming.map((message) => [message.id, message]));
  if (prepend) {
    return [
      ...incoming,
      ...existing.filter((message) => !incomingById.has(message.id)),
    ];
  }
  const existingIds = new Set(existing.map((message) => message.id));
  return [
    ...existing.map((message) => incomingById.get(message.id) ?? message),
    ...incoming.filter((message) => !existingIds.has(message.id)),
  ];
}

function hasExternalMcpSurface(status) {
  return (status.runtimeStatus !== null && status.runtimeStatus !== "disabled")
    || Object.keys(status.tools ?? {}).length > 0
    || (status.resources?.length ?? 0) > 0
    || (status.resourceTemplates?.length ?? 0) > 0;
}

export class CodexSessionService extends EventEmitter {
  #client;
  #clientFactory;
  #cwd;
  #onServerRequest;
  #transcripts = new Map();
  #transcriptOperations = new Map();
  #connected = false;
  #workspaceWriteEnabled = false;
  #runtime = new Map();
  #rateLimits = null;
  #turnSettings = new Map();

  constructor({
    cwd = process.cwd(),
    socketPath,
    catalogPath,
    clientFactory = (options) => CodexAppServerClient.connectUnixWebSocket(options),
    onServerRequest = null,
  } = {}) {
    super();
    this.#cwd = cwd;
    this.socketPath = socketPath;
    this.#clientFactory = clientFactory;
    this.#onServerRequest = onServerRequest;
    this.catalog = new ManagedThreadCatalog(catalogPath);
  }

  async connect() {
    if (this.#connected) return;
    this.#client = await this.#clientFactory({
      cwd: this.#cwd,
      socketPath: this.socketPath,
      onServerRequest: this.#onServerRequest,
      onNotification: (notification) => this.#handleNotification(notification),
    });
    try {
      await this.#client.initialize();
      await this.#assertNoExternalMcp();
      this.#workspaceWriteEnabled = await this.#hasManagedApprovalHook();
      this.#connected = true;
      await this.#readRateLimits();
    } catch (error) {
      await this.#client.close().catch(() => {});
      this.#client = null;
      throw error;
    }
  }

  get workspaceWriteEnabled() {
    return this.#workspaceWriteEnabled;
  }

  async listSessions() {
    this.#assertConnected();
    const active = await this.#listThreads(false);
    const activeIds = new Set(active.map((thread) => thread.id));
    const missingIds = [...this.catalog.read()].filter((threadId) => !activeIds.has(threadId));
    if (missingIds.length) {
      const archivedIds = new Set((await this.#listThreads(true)).map((thread) => thread.id));
      for (const threadId of missingIds) {
        if (archivedIds.has(threadId)) this.catalog.remove(threadId);
      }
    }
    return active
      .map((thread) => publicSession(thread, false, this.#runtime.get(thread.id), this.#rateLimits))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async createSession({ prompt, name = null, cwd = this.#cwd } = {}) {
    this.#assertConnected();
    if (typeof prompt !== "string" || !prompt.trim()) {
      throw new CodexSessionError("INVALID_PROMPT", "새 세션의 최초 프롬프트가 필요합니다");
    }
    const response = await this.#client.request("thread/start", {
      cwd,
      approvalPolicy: this.#workspaceWriteEnabled ? "on-request" : "never",
      approvalsReviewer: "user",
      sandbox: this.#workspaceWriteEnabled ? "workspace-write" : "read-only",
      config: this.#workspaceWriteEnabled ? { bypass_hook_trust: true } : undefined,
      ephemeral: false,
      dynamicTools: [],
      threadSource: THREAD_SOURCE,
    });
    this.#rememberMetadata(response.thread?.id, response);
    this.#assertSessionIsolation(response);
    const threadId = response.thread?.id;
    if (!threadId) throw new CodexSessionError("THREAD_ID_MISSING", "Codex가 thread id를 반환하지 않았습니다");
    if (response.thread.threadSource !== THREAD_SOURCE) {
      throw new CodexSessionError("THREAD_SOURCE_MISMATCH", "Codex가 Waga thread source를 보존하지 않았습니다");
    }
    this.catalog.record(threadId);
    await this.#assertNoExternalMcp(threadId);

    const sessionName = (name || prompt.trim()).slice(0, 80);
    await this.#client.request("thread/name/set", { threadId, name: sessionName });
    await this.#startTurn(threadId, prompt.trim());
    return publicSession(
      { ...response.thread, name: sessionName, status: { type: "active", activeFlags: [] } },
      false,
      this.#runtime.get(threadId),
      this.#rateLimits,
    );
  }

  async openSession(threadId, selectedSession = null) {
    this.#assertConnected();
    let session = selectedSession?.threadId === threadId && this.catalog.read().has(threadId)
      ? selectedSession
      : await this.#findSession(threadId);
    if (!session) throw new CodexSessionError("SESSION_NOT_FOUND", `관리 세션을 찾을 수 없습니다: ${threadId}`);
    const response = await this.#client.request("thread/resume", {
      threadId,
      cwd: session.cwd,
      approvalPolicy: this.#workspaceWriteEnabled ? "on-request" : "never",
      approvalsReviewer: "user",
      sandbox: this.#workspaceWriteEnabled ? "workspace-write" : "read-only",
      config: this.#workspaceWriteEnabled ? { bypass_hook_trust: true } : undefined,
      excludeTurns: true,
    });
    this.#assertSessionIsolation(response);
    this.#rememberMetadata(threadId, response);
    await this.#assertNoExternalMcp(threadId);
    session = publicSession(response.thread, false, this.#runtime.get(threadId), this.#rateLimits);
    return { ...session, ...await this.#readRecentTranscript(threadId) };
  }

  async readSession(threadId, selectedSession = null) {
    this.#assertConnected();
    const session = selectedSession?.threadId === threadId && this.catalog.read().has(threadId)
      ? selectedSession
      : await this.#findSession(threadId);
    if (!session) throw new CodexSessionError("SESSION_NOT_FOUND", `관리 세션을 찾을 수 없습니다: ${threadId}`);
    return { ...session, ...await this.#readRecentTranscript(threadId) };
  }

  async loadOlderMessages(threadId, selectedSession = null) {
    this.#assertConnected();
    const session = selectedSession?.threadId === threadId && this.catalog.read().has(threadId)
      ? selectedSession
      : await this.#findSession(threadId);
    if (!session) throw new CodexSessionError("SESSION_NOT_FOUND", `관리 세션을 찾을 수 없습니다: ${threadId}`);
    const transcript = await this.#serializeTranscript(threadId, async () => {
      let current = this.#transcripts.get(threadId) ?? await this.#fetchRecentTranscript(threadId);
      if (!current.olderCursor) return this.#publicTranscript(current);

      const page = await this.#client.request("thread/items/list", {
        threadId,
        cursor: current.olderCursor,
        limit: TRANSCRIPT_ITEM_PAGE_SIZE,
        sortDirection: "desc",
      });
      const older = page.data.map(publicMessage).filter(Boolean).reverse();
      current = {
        messages: mergeMessages(current.messages, older, { prepend: true }),
        olderCursor: page.nextCursor ?? null,
        expanded: true,
      };
      this.#transcripts.set(threadId, current);
      return this.#publicTranscript(current);
    });
    return { ...session, ...transcript };
  }

  async sendMessage(threadId, text) {
    this.#assertConnected();
    if (typeof text !== "string" || !text.trim()) {
      throw new CodexSessionError("INVALID_MESSAGE", "보낼 메시지가 필요합니다");
    }
    let session = await this.#findSession(threadId);
    if (!session) throw new CodexSessionError("SESSION_NOT_FOUND", `관리 세션을 찾을 수 없습니다: ${threadId}`);
    if (session.status === "Stopped") throw new CodexSessionError("SESSION_STOPPED", "종료한 세션에는 메시지를 보낼 수 없습니다");
    if (session.status === "Sleeping") {
      await this.openSession(threadId);
      session = await this.#findSession(threadId);
    }
    if (session.status === "Working") {
      const turn = await this.#activeTurn(threadId);
      if (!turn) throw new CodexSessionError("ACTIVE_TURN_MISSING", "진행 중인 Codex 턴 ID를 찾을 수 없습니다");
      const response = await this.#client.request("turn/steer", {
        threadId,
        input: [{ type: "text", text: text.trim(), text_elements: [] }],
        expectedTurnId: turn.id,
      });
      this.emit("changed", { method: "waga/turn-steered", params: { threadId, turnId: response.turnId } });
      return { id: response.turnId, status: "inProgress" };
    }
    return this.#startTurn(threadId, text.trim());
  }

  async executeCommand(threadId, command, argument = "") {
    this.#assertConnected();
    const session = await this.#findSession(threadId);
    if (!session) throw new CodexSessionError("SESSION_NOT_FOUND", `관리 세션을 찾을 수 없습니다: ${threadId}`);
    const value = argument.trim();

    if (command === "/compact") {
      this.#assertIdleCommand(session, command);
      await this.#client.request("thread/compact/start", { threadId });
      this.emit("changed", { method: "waga/thread-compacted", params: { threadId } });
      return { message: "Codex 컨텍스트 압축을 시작했습니다" };
    }
    if (command === "/fork") {
      this.#assertIdleCommand(session, command);
      const response = await this.#client.request("thread/fork", {
        threadId,
        cwd: session.cwd,
        approvalPolicy: this.#workspaceWriteEnabled ? "on-request" : "never",
        approvalsReviewer: "user",
        sandbox: this.#workspaceWriteEnabled ? "workspace-write" : "read-only",
        config: this.#workspaceWriteEnabled ? { bypass_hook_trust: true } : undefined,
        excludeTurns: true,
        ephemeral: false,
        threadSource: THREAD_SOURCE,
      });
      this.#assertSessionIsolation(response);
      const forkId = response.thread?.id;
      if (!forkId) throw new CodexSessionError("THREAD_ID_MISSING", "Codex가 fork thread id를 반환하지 않았습니다");
      this.catalog.record(forkId);
      this.#rememberMetadata(forkId, response);
      const name = value || `${session.name} (fork)`;
      await this.#client.request("thread/name/set", { threadId: forkId, name });
      const forked = publicSession({ ...response.thread, name }, false, this.#runtime.get(forkId), this.#rateLimits);
      this.emit("changed", { method: "waga/thread-forked", params: { threadId, forkId } });
      return { message: `'${name}' 세션으로 분기했습니다`, session: forked };
    }
    if (command === "/review") {
      this.#assertIdleCommand(session, command);
      const target = value
        ? { type: "custom", instructions: value }
        : { type: "uncommittedChanges" };
      const response = await this.#client.request("review/start", { threadId, target, delivery: "inline" });
      this.#rememberTurnStarted(threadId, response.turn);
      this.emit("changed", { method: "waga/review-started", params: { threadId, turn: response.turn } });
      return { message: value ? "지정한 기준으로 코드 리뷰를 시작했습니다" : "현재 변경사항 코드 리뷰를 시작했습니다" };
    }
    if (command === "/model") {
      const page = await this.#client.request("model/list", { limit: 100, includeHidden: false });
      const models = page.data ?? [];
      if (!value) {
        const current = this.#turnSettings.get(threadId)?.model ?? session.model ?? "default";
        return { message: `현재 모델: ${current} · 사용 가능: ${models.map((model) => model.model).join(", ")}` };
      }
      const selected = models.find((model) => model.model === value || model.id === value || model.displayName === value);
      if (!selected) throw new CodexSessionError("MODEL_NOT_FOUND", `사용 가능한 Codex 모델이 아닙니다: ${value}`);
      this.#setTurnSetting(threadId, "model", selected.model);
      this.#runtimeFor(threadId).model = selected.model;
      return { message: `다음 턴부터 모델을 ${selected.displayName}(${selected.model})(으)로 사용합니다` };
    }
    if (command === "/effort") {
      if (!value) {
        const current = this.#turnSettings.get(threadId)?.effort ?? session.reasoningEffort ?? "default";
        return { message: `현재 추론 강도: ${current} · /effort low|medium|high|xhigh|max` };
      }
      if (!new Set(["low", "medium", "high", "xhigh", "max"]).has(value)) {
        throw new CodexSessionError("INVALID_EFFORT", "사용법: /effort low|medium|high|xhigh|max");
      }
      this.#setTurnSetting(threadId, "effort", value);
      this.#runtimeFor(threadId).reasoningEffort = value;
      return { message: `다음 턴부터 추론 강도를 ${value}(으)로 사용합니다` };
    }
    if (command === "/fast") {
      const current = this.#turnSettings.get(threadId)?.serviceTier ?? session.serviceTier ?? "default";
      if (!value) return { message: `현재 응답 속도 tier: ${current} · /fast on|off` };
      if (!new Set(["on", "off"]).has(value)) throw new CodexSessionError("INVALID_FAST_MODE", "사용법: /fast on|off");
      if (value === "on") {
        const page = await this.#client.request("model/list", { limit: 100, includeHidden: false });
        const modelName = this.#turnSettings.get(threadId)?.model ?? session.model;
        const model = page.data.find((candidate) => candidate.model === modelName)
          ?? page.data.find((candidate) => candidate.isDefault);
        if (!model?.serviceTiers?.some((tier) => tier.id === "priority")) {
          throw new CodexSessionError("FAST_MODE_UNAVAILABLE", `${modelName ?? "현재 모델"}은(는) Fast tier를 지원하지 않습니다`);
        }
      }
      const serviceTier = value === "on" ? "priority" : null;
      this.#setTurnSetting(threadId, "serviceTier", serviceTier);
      this.#runtimeFor(threadId).serviceTier = serviceTier;
      return { message: value === "on" ? "다음 턴부터 Fast tier(priority)를 사용합니다" : "다음 턴부터 기본 응답 속도를 사용합니다" };
    }
    if (command === "/personality") {
      if (!value) return { message: `현재 personality: ${this.#turnSettings.get(threadId)?.personality ?? "default"} · /personality none|friendly|pragmatic` };
      if (!new Set(["none", "friendly", "pragmatic"]).has(value)) {
        throw new CodexSessionError("INVALID_PERSONALITY", "사용법: /personality none|friendly|pragmatic");
      }
      this.#setTurnSetting(threadId, "personality", value);
      return { message: `다음 턴부터 personality를 ${value}(으)로 사용합니다` };
    }
    if (command === "/permissions") {
      return {
        message: this.#workspaceWriteEnabled
          ? "현재 권한: workspace-write + on-request 직접 승인 · Waga 안전 정책상 슬래시 명령으로 권한을 확대할 수 없습니다"
          : "현재 권한: read-only + never · 승인 hook이 확인되지 않아 쓰기가 잠겨 있습니다",
      };
    }
    if (command === "/mcp") {
      const page = await this.#client.request("mcpServerStatus/list", { threadId, limit: MAX_PAGE_SIZE, detail: "full" });
      const active = page.data.filter(hasExternalMcpSurface).map(({ name }) => name);
      return { message: active.length ? `활성 MCP: ${active.join(", ")}` : "Waga 관리 세션은 외부 MCP가 모두 비활성화되어 있습니다" };
    }
    if (command === "/skills") {
      const result = await this.#client.request("skills/list", { cwds: [session.cwd], forceReload: false });
      const skills = (result.data ?? []).flatMap((entry) => entry.skills ?? []).map((skill) => skill.name).filter(Boolean);
      return { message: skills.length ? `사용 가능한 스킬 ${skills.length}개: ${skills.join(", ")}` : "현재 workspace에서 발견한 스킬이 없습니다" };
    }
    throw new CodexSessionError("COMMAND_UNSUPPORTED", `Waga에서 실행할 수 없는 Codex 명령입니다: ${command}`);
  }

  async #startTurn(threadId, text) {
    const settings = this.#turnSettings.get(threadId) ?? {};
    const response = await this.#client.request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      turnTrigger: "waga-user",
      model: settings.model,
      effort: settings.effort,
      personality: settings.personality,
      serviceTier: settings.serviceTier,
      responsesapiClientMetadata: { waga_origin: "direct-human-tui" },
      approvalPolicy: this.#workspaceWriteEnabled ? "on-request" : "never",
      approvalsReviewer: "user",
      sandboxPolicy: this.#workspaceWriteEnabled
        ? {
            type: "workspaceWrite",
            writableRoots: [],
            networkAccess: false,
            excludeTmpdirEnvVar: false,
            excludeSlashTmp: false,
          }
        : { type: "readOnly", networkAccess: false },
    });
    this.#rememberTurnStarted(threadId, response.turn);
    this.emit("changed", { method: "waga/turn-started", params: { threadId, turn: response.turn } });
    return response.turn;
  }

  async interruptSession(threadId) {
    this.#assertConnected();
    const session = await this.#findSession(threadId);
    if (!session) throw new CodexSessionError("SESSION_NOT_FOUND", `관리 세션을 찾을 수 없습니다: ${threadId}`);
    const turn = await this.#activeTurn(threadId);
    if (!turn) throw new CodexSessionError("NO_ACTIVE_TURN", "중단할 진행 중인 Codex 턴이 없습니다");
    await this.#client.request("turn/interrupt", { threadId, turnId: turn.id });
    this.#rememberTurnCompleted(threadId, { ...turn, status: "interrupted" });
    this.emit("changed", { method: "waga/turn-interrupted", params: { threadId, turnId: turn.id } });
    return { interrupted: true, threadId, turnId: turn.id };
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
    const session = await this.#findSession(threadId);
    if (!session) throw new CodexSessionError("SESSION_NOT_FOUND", `관리 세션을 찾을 수 없습니다: ${threadId}`);
    if (session.status === "Stopped") return;
    const turns = await this.#client.request("thread/turns/list", {
      threadId,
      limit: 20,
      sortDirection: "desc",
      itemsView: "summary",
    });
    const activeTurn = turns.data.find((turn) => turn.status === "inProgress");
    if (activeTurn) {
      await this.#client.request("turn/interrupt", { threadId, turnId: activeTurn.id });
      this.#rememberTurnCompleted(threadId, { ...activeTurn, status: "interrupted" });
    }
    await this.#client.request("thread/archive", { threadId });
    this.#transcripts.delete(threadId);
    this.#runtime.delete(threadId);
    this.#turnSettings.delete(threadId);
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
        limit: MAX_PAGE_SIZE,
        sortDirection: "desc",
        sortKey: "updated_at",
        useStateDbOnly: true,
      });
      for (const thread of page.data) {
        const isWagaThread = thread.threadSource === THREAD_SOURCE || LEGACY_THREAD_SOURCES.has(thread.threadSource);
        if (isWagaThread) this.catalog.record(thread.id);
        if (isWagaThread || managedIds.has(thread.id)) threads.push(thread);
      }
      cursor = page.nextCursor;
    } while (cursor);
    return threads;
  }

  async #readRecentTranscript(threadId) {
    return this.#serializeTranscript(threadId, async () => {
      const recent = await this.#fetchRecentTranscript(threadId);
      const cached = this.#transcripts.get(threadId);
      const transcript = cached?.expanded
        ? {
            messages: mergeMessages(cached.messages, recent.messages),
            olderCursor: cached.olderCursor,
            expanded: true,
          }
        : recent;
      this.#transcripts.set(threadId, transcript);
      return this.#publicTranscript(transcript);
    });
  }

  async #fetchRecentTranscript(threadId) {
    const page = await this.#client.request("thread/items/list", {
      threadId,
      limit: TRANSCRIPT_ITEM_PAGE_SIZE,
      sortDirection: "desc",
    });
    return {
      messages: page.data.map(publicMessage).filter(Boolean).reverse(),
      olderCursor: page.nextCursor ?? null,
      expanded: false,
    };
  }

  #publicTranscript(transcript) {
    return {
      messages: transcript.messages,
      hasOlderMessages: transcript.olderCursor !== null,
    };
  }

  #serializeTranscript(threadId, operation) {
    const previous = this.#transcriptOperations.get(threadId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    const tracked = current.finally(() => {
      if (this.#transcriptOperations.get(threadId) === tracked) {
        this.#transcriptOperations.delete(threadId);
      }
    });
    this.#transcriptOperations.set(threadId, tracked);
    return tracked;
  }

  async #findSession(threadId) {
    return (await this.listSessions()).find((session) => session.threadId === threadId) ?? null;
  }

  async #activeTurn(threadId) {
    const cached = this.#runtime.get(threadId)?.activeTurnId;
    if (cached) return { id: cached, status: "inProgress" };
    const turns = await this.#client.request("thread/turns/list", {
      threadId,
      limit: 20,
      sortDirection: "desc",
      itemsView: "summary",
    });
    const turn = turns.data.find((candidate) => candidate.status === "inProgress") ?? null;
    if (turn) this.#rememberTurnStarted(threadId, turn);
    return turn;
  }

  #runtimeFor(threadId) {
    const current = this.#runtime.get(threadId) ?? {};
    this.#runtime.set(threadId, current);
    return current;
  }

  #setTurnSetting(threadId, key, value) {
    const current = this.#turnSettings.get(threadId) ?? {};
    this.#turnSettings.set(threadId, { ...current, [key]: value });
  }

  #assertIdleCommand(session, command) {
    if (session.status === "Working") {
      throw new CodexSessionError("TURN_IN_PROGRESS", `${command} 명령은 현재 턴이 끝난 뒤 실행할 수 있습니다`);
    }
  }

  #rememberMetadata(threadId, response) {
    if (!threadId) return;
    const runtime = this.#runtimeFor(threadId);
    if (response.thread?.status) runtime.status = response.thread.status;
    if (response.thread?.gitInfo) runtime.gitInfo = response.thread.gitInfo;
    if (typeof response.model === "string") runtime.model = response.model;
    if (response.reasoningEffort != null) runtime.reasoningEffort = response.reasoningEffort;
    if (response.serviceTier != null) runtime.serviceTier = response.serviceTier;
  }

  #rememberTurnStarted(threadId, turn) {
    if (!threadId || !turn?.id) return;
    const runtime = this.#runtimeFor(threadId);
    runtime.status = { type: "active", activeFlags: [] };
    runtime.activeTurnId = turn.id;
    runtime.workingSince = Number.isFinite(turn.startedAt) ? turn.startedAt * 1_000 : Date.now();
  }

  #rememberTurnCompleted(threadId, turn) {
    if (!threadId) return;
    const runtime = this.#runtimeFor(threadId);
    if (!turn?.id || runtime.activeTurnId === turn.id) {
      runtime.activeTurnId = null;
      runtime.workingSince = null;
    }
    runtime.status = { type: "idle" };
  }

  #handleNotification(notification) {
    const { method, params = {} } = notification ?? {};
    if (method === "thread/status/changed" && params.threadId && params.status) {
      this.#runtimeFor(params.threadId).status = params.status;
    } else if (method === "turn/started") {
      this.#rememberTurnStarted(params.threadId, params.turn);
    } else if (method === "turn/completed") {
      this.#rememberTurnCompleted(params.threadId, params.turn);
    } else if (method === "thread/tokenUsage/updated" && params.threadId) {
      this.#runtimeFor(params.threadId).tokenUsage = params.tokenUsage;
    } else if (method === "account/rateLimits/updated" && params.rateLimits) {
      this.#mergeRateLimits(params.rateLimits);
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

  #mergeRateLimits(update) {
    const current = this.#rateLimits ?? {};
    const mergeWindow = (name) => {
      if (!(name in update)) return current[name];
      if (update[name] === null) return null;
      return { ...(current[name] ?? {}), ...update[name] };
    };
    this.#rateLimits = {
      ...current,
      ...update,
      primary: mergeWindow("primary"),
      secondary: mergeWindow("secondary"),
    };
  }

  async #assertNoExternalMcp(threadId = null) {
    const page = await this.#client.request("mcpServerStatus/list", {
      threadId,
      limit: MAX_PAGE_SIZE,
      detail: "full",
    });
    const unsafe = page.data.filter(hasExternalMcpSurface);
    if (unsafe.length) {
      throw new CodexSessionError(
        "EXTERNAL_MCP_ENABLED",
        `외부 MCP가 비활성화되지 않았습니다: ${unsafe.map((status) => status.name).join(", ")}`,
      );
    }
  }

  async #hasManagedApprovalHook() {
    const result = await this.#client.request("hooks/list", { cwds: [this.#cwd] });
    const project = result.data?.find((entry) => entry.cwd === this.#cwd);
    if (!project || (project.errors?.length ?? 0) > 0) return false;
    return project.hooks.some((hook) => (
      hook.eventName === "preToolUse"
      && hook.handlerType === "command"
      && hook.command === `node ${JSON.stringify(APPROVAL_GATE_PATH)}`
      && hook.matcher === APPROVAL_HOOK_MATCHER
      && hook.async === false
      && hook.enabled === true
      && hook.source === "sessionFlags"
    ));
  }

  #assertSessionIsolation(response) {
    const expected = this.#workspaceWriteEnabled ? "workspaceWrite" : "readOnly";
    if (response.sandbox?.type !== expected) {
      throw new CodexSessionError(
        "CODEX_SESSION_ISOLATION_FAILED",
        `Codex 관리 세션이 기대한 ${expected} sandbox로 생성되지 않았습니다`,
      );
    }
  }

  #assertConnected() {
    if (!this.#connected) throw new CodexSessionError("SERVICE_NOT_CONNECTED", "Codex daemon에 연결되지 않았습니다");
  }
}
