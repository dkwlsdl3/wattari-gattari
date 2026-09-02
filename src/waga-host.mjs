import { EventEmitter } from "node:events";

import { VERSION } from "./product.mjs";

function hostError(code, message) {
  return Object.assign(new Error(message), { code });
}

function sameState(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class WagaHost extends EventEmitter {
  #registry;
  #sessionFactory;
  #approvalServer;
  #approvalLedger;
  #approval = null;
  #services = new Map();
  #serviceStarts = new Map();
  #sessions = new Map();
  #refreshTimers = new Map();
  #forcePublishWorkspaces = new Set();
  #refreshOperations = new Map();
  #revision = 0;
  #closed = false;

  constructor({ registry, sessionFactory, approvalServer = null, approvalLedger = null }) {
    super();
    if (!registry || typeof registry.snapshot !== "function") throw new TypeError("Host requires a workspace registry");
    if (typeof sessionFactory !== "function") throw new TypeError("Host requires a session factory");
    this.#registry = registry;
    this.#sessionFactory = sessionFactory;
    this.#approvalServer = approvalServer;
    this.#approvalLedger = approvalLedger;
  }

  async start() {
    if (this.#approvalServer) {
      this.#approvalServer.on("request", (request) => this.#acceptApprovalRequest(request));
      this.#approvalServer.on("resolved", ({ requestId }) => this.#clearApproval(requestId));
      this.#approvalServer.on("abandoned", ({ requestId }) => this.#clearApproval(requestId));
      await this.#approvalServer.start();
    }
    const workspaces = this.#registry.snapshot().workspaces;
    await Promise.all(workspaces.map(async (workspace) => {
      await this.#ensureService(workspace.path);
      await this.#refreshWorkspace(workspace.path, { publish: false });
    }));
    this.#publish();
  }

  async close() {
    this.#closed = true;
    for (const timer of this.#refreshTimers.values()) clearTimeout(timer);
    this.#refreshTimers.clear();
    this.#forcePublishWorkspaces.clear();
    await Promise.allSettled([...this.#refreshOperations.values()]);
    await Promise.all([...this.#services.values()].map((service) => Promise.resolve(service.detach?.()).catch(() => {})));
    this.#services.clear();
    await this.#approvalServer?.close();
  }

  snapshot() {
    const registry = this.#registry.snapshot();
    return {
      version: VERSION,
      revision: this.#revision,
      approval: this.#approval ? structuredClone(this.#approval) : null,
      workspaces: registry.workspaces.map((workspace) => {
        const sessions = this.#sessions.get(workspace.path) ?? [];
        const order = new Map(workspace.sessionOrder.map((key, index) => [key, index]));
        const completed = new Set(workspace.completedSessions ?? []);
        return {
          path: workspace.path,
          name: workspace.name,
          sessions: sessions.map((session) => completed.has(session.id)
            ? { ...session, status: "Completed", routable: false }
            : session).sort((left, right) => {
            const leftOrder = order.get(left.id) ?? Number.MAX_SAFE_INTEGER;
            const rightOrder = order.get(right.id) ?? Number.MAX_SAFE_INTEGER;
            return leftOrder - rightOrder || right.updatedAt - left.updatedAt;
          }),
        };
      }),
    };
  }

  async dispatch(method, params = {}) {
    switch (method) {
      case "state/get":
        return this.snapshot();
      case "workspace/register":
        return this.#registerWorkspace(params.path);
      case "workspace/unregister":
        return this.#unregisterWorkspace(params.path);
      case "workspace/stopAll":
        return this.#stopAllSessions(params.path);
      case "session/create":
        return this.#createSession(params);
      case "session/open":
        return this.#sessionCall(params, "openSession", params.threadId);
      case "session/read":
        return this.#sessionCall(params, "readSession", params.threadId);
      case "session/older":
        return this.#sessionCall(params, "loadOlderMessages", params.threadId);
      case "session/send": {
        const result = await this.#sessionCall(params, "sendMessage", params.threadId, params.text);
        const selected = (this.#sessions.get(params.workspacePath) ?? []).find((session) => session.threadId === params.threadId);
        const reopened = selected
          ? this.#registry.setSessionCompleted(params.workspacePath, selected.id, false)
          : false;
        await this.#refreshWorkspace(params.workspacePath, { forcePublish: reopened });
        return result;
      }
      case "session/command": {
        const result = await this.#sessionCall(
          params,
          "executeCommand",
          params.threadId,
          params.command,
          params.argument ?? "",
        );
        await this.#refreshWorkspace(params.workspacePath);
        return result;
      }
      case "session/interrupt": {
        const result = await this.#sessionCall(params, "interruptSession", params.threadId);
        await this.#refreshWorkspace(params.workspacePath);
        return result;
      }
      case "session/rename": {
        const result = await this.#sessionCall(params, "renameSession", params.threadId, params.name);
        await this.#refreshWorkspace(params.workspacePath);
        return result;
      }
      case "session/stop":
        return this.#stopSession(params);
      case "session/reorder":
        return this.#reorderSession(params);
      case "session/setCompleted":
        return this.#setSessionCompleted(params);
      case "approval/resolve":
        return this.#resolveApproval(params);
      case "daemon/shutdown":
        setImmediate(() => this.emit("shutdownRequested"));
        return { stopping: true };
      default:
        throw hostError("METHOD_NOT_FOUND", `Unknown control method: ${method ?? "<missing>"}`);
    }
  }

  async #registerWorkspace(workspacePath) {
    const before = this.snapshot().workspaces;
    const workspace = this.#registry.register(workspacePath);
    await this.#ensureService(workspace.path);
    await this.#refreshWorkspace(workspace.path, { publish: false });
    if (!sameState(before, this.snapshot().workspaces)) this.#publish();
    return this.snapshot();
  }

  async #unregisterWorkspace(workspacePath) {
    const sessions = this.#sessions.get(workspacePath) ?? [];
    if (sessions.length > 0) throw hostError("WORKSPACE_NOT_EMPTY", "세션이 남아 있는 workspace는 등록 해제할 수 없습니다");
    const removed = this.#registry.unregister(workspacePath);
    if (!removed) return this.snapshot();
    const service = this.#services.get(workspacePath);
    this.#services.delete(workspacePath);
    this.#sessions.delete(workspacePath);
    await service?.detach?.();
    this.#publish();
    return this.snapshot();
  }

  async #stopAllSessions(workspacePath) {
    const service = await this.#service(workspacePath);
    const sessions = [...(this.#sessions.get(workspacePath) ?? [])];
    for (const session of sessions) {
      await service.stopSession(session.threadId);
      this.#registry.removeSession(workspacePath, session.id);
    }
    await this.#refreshWorkspace(workspacePath);
    return { stopped: sessions.map((session) => session.threadId) };
  }

  async #createSession({ workspacePath, prompt, name, provider = "codex" }) {
    const service = await this.#service(workspacePath);
    const session = await service.createSession({ prompt, name, cwd: workspacePath, provider });
    this.#registry.recordSession(workspacePath, session.id);
    await this.#refreshWorkspace(workspacePath);
    return session;
  }

  async #stopSession({ workspacePath, threadId }) {
    const service = await this.#service(workspacePath);
    const selected = (this.#sessions.get(workspacePath) ?? []).find((session) => session.threadId === threadId);
    await service.stopSession(threadId, selected);
    if (selected) this.#registry.removeSession(workspacePath, selected.id);
    await this.#refreshWorkspace(workspacePath);
    return { stopped: true, threadId };
  }

  async #reorderSession({ workspacePath, sessionId, direction }) {
    const changed = this.#registry.moveSession(workspacePath, sessionId, direction);
    if (changed) this.#publish();
    return { changed, state: this.snapshot() };
  }

  #setSessionCompleted({ workspacePath, sessionId, completed }) {
    if (typeof completed !== "boolean") throw hostError("COMPLETED_INVALID", "완료 상태는 boolean이어야 합니다");
    const session = (this.#sessions.get(workspacePath) ?? []).find((candidate) => candidate.id === sessionId);
    if (!session) throw hostError("SESSION_NOT_FOUND", `관리 세션을 찾을 수 없습니다: ${sessionId}`);
    if (completed && !["Awaiting input", "Sleeping", "Completed"].includes(session.status)) {
      throw hostError("SESSION_NOT_IDLE", "작업 중인 세션은 완료로 표시할 수 없습니다");
    }
    const changed = this.#registry.setSessionCompleted(workspacePath, sessionId, completed);
    if (changed) this.#publish();
    return { changed, completed, state: this.snapshot() };
  }

  async #sessionCall(params, method, ...args) {
    const service = await this.#service(params.workspacePath);
    const selected = (this.#sessions.get(params.workspacePath) ?? []).find((session) => session.threadId === params.threadId);
    args.push(selected);
    return service[method](...args);
  }

  async #service(workspacePath) {
    const registered = this.#registry.snapshot().workspaces.some((workspace) => workspace.path === workspacePath);
    if (!registered) throw hostError("WORKSPACE_NOT_REGISTERED", `등록되지 않은 workspace입니다: ${workspacePath}`);
    return this.#ensureService(workspacePath);
  }

  async #ensureService(workspacePath) {
    if (this.#services.has(workspacePath)) return this.#services.get(workspacePath);
    if (this.#serviceStarts.has(workspacePath)) return this.#serviceStarts.get(workspacePath);
    const start = (async () => {
      const service = this.#sessionFactory(workspacePath, {
        onServerRequest: (request) => this.handleServerRequest(request),
      });
      service.on?.("changed", () => this.#scheduleRefresh(workspacePath, { forcePublish: true }));
      await service.connect();
      this.#services.set(workspacePath, service);
      return service;
    })();
    this.#serviceStarts.set(workspacePath, start);
    try {
      return await start;
    } finally {
      this.#serviceStarts.delete(workspacePath);
    }
  }

  async #refreshWorkspace(workspacePath, { publish = true, forcePublish = false } = {}) {
    const previous = this.#refreshOperations.get(workspacePath) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => this.#performRefresh(workspacePath, { publish, forcePublish }));
    const tracked = current.finally(() => {
      if (this.#refreshOperations.get(workspacePath) === tracked) this.#refreshOperations.delete(workspacePath);
    });
    this.#refreshOperations.set(workspacePath, tracked);
    return tracked;
  }

  async #performRefresh(workspacePath, { publish, forcePublish }) {
    if (this.#closed) return;
    const service = await this.#ensureService(workspacePath);
    const sessions = await service.listSessions();
    const currentIds = new Set(sessions.map((session) => session.id));
    const workspace = this.#registry.snapshot().workspaces.find((entry) => entry.path === workspacePath);
    for (const sessionId of workspace?.sessionOrder ?? []) {
      if (!currentIds.has(sessionId)) this.#registry.removeSession(workspacePath, sessionId);
    }
    for (const session of sessions) this.#registry.recordSession(workspacePath, session.id);
    for (const session of sessions) {
      if (session.status === "Working") this.#registry.setSessionCompleted(workspacePath, session.id, false);
    }
    const previous = this.#sessions.get(workspacePath) ?? [];
    this.#sessions.set(workspacePath, sessions);
    if (publish && (forcePublish || !sameState(previous, sessions))) this.#publish();
    else if (publish && !this.#revision) this.#publish();
  }

  #scheduleRefresh(workspacePath, { forcePublish = false } = {}) {
    if (this.#closed) return;
    if (forcePublish) this.#forcePublishWorkspaces.add(workspacePath);
    if (this.#refreshTimers.has(workspacePath)) return;
    const timer = setTimeout(() => {
      this.#refreshTimers.delete(workspacePath);
      const shouldForcePublish = this.#forcePublishWorkspaces.delete(workspacePath);
      void this.#refreshWorkspace(workspacePath, { forcePublish: shouldForcePublish }).catch((error) => this.emit("error", error));
    }, 25);
    this.#refreshTimers.set(workspacePath, timer);
  }

  #publish() {
    this.#revision += 1;
    this.emit("state", this.snapshot());
  }

  handleServerRequest(request) {
    return this.#approvalLedger?.consumeServerRequest(request);
  }

  #acceptApprovalRequest(request) {
    const managed = [...this.#sessions.values()].flat().some((session) => session.threadId === request.payload.session_id);
    if (!managed) {
      this.#approvalServer.resolve(request.requestId, "deny");
      return;
    }
    this.#approval = request;
    this.emit("approval", structuredClone(request));
  }

  #clearApproval(requestId) {
    if (this.#approval?.requestId !== requestId) return;
    this.#approval = null;
    this.emit("approval", null);
  }

  #resolveApproval({ requestId, decision }) {
    if (!this.#approval || this.#approval.requestId !== requestId) {
      throw hostError("APPROVAL_NOT_CURRENT", "현재 화면의 승인 요청과 일치하지 않습니다");
    }
    if (decision !== "approve" && decision !== "deny") {
      throw hostError("APPROVAL_DECISION_INVALID", "승인은 approve 또는 deny여야 합니다");
    }
    const resolvedDecision = decision === "approve" && this.#approvalLedger?.authorizeHook(this.#approval.payload)
      ? "approve"
      : "deny";
    if (!this.#approvalServer.resolve(requestId, resolvedDecision)) {
      throw hostError("APPROVAL_NOT_CURRENT", "승인 요청이 이미 해결되었거나 만료됐습니다");
    }
    return { requestId, decision: resolvedDecision };
  }
}
