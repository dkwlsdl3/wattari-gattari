import crypto from "node:crypto";

export class BridgeError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.code = code;
  }
}

function providerFromTarget(target) {
  const match = /^(claude|codex):/.exec(target);
  return match?.[1] ?? null;
}

export class SessionBridge {
  #providers;
  #router;
  #createRouter;
  #requests;

  constructor({ providers, router = null, createRouter = null, requestStore = null }) {
    if (!Array.isArray(providers) || providers.length === 0) {
      throw new TypeError("SessionBridge requires at least one provider");
    }
    this.#providers = new Map(providers.map((provider) => [provider.name, provider]));
    if (router !== null && typeof router !== "function") throw new TypeError("SessionBridge router must be a function");
    if (createRouter !== null && typeof createRouter !== "function") throw new TypeError("SessionBridge createRouter must be a function");
    this.#router = router;
    this.#createRouter = createRouter;
    this.#requests = requestStore;
  }

  async discover({ provider, cwd, includeUsage = false } = {}) {
    const selected = provider ? [this.#provider(provider)] : [...this.#providers.values()];
    const results = await Promise.allSettled(selected.map((adapter) => adapter.list(includeUsage ? { cwd, includeUsage: true } : { cwd })));
    const sessions = [];
    const warnings = [];
    const availableProviders = [];
    const providerUsage = {};
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const adapter = selected[index];
      if (result.status === "fulfilled") {
        sessions.push(...result.value);
        availableProviders.push(adapter.name);
        const usage = includeUsage && typeof adapter.usageSnapshot === "function" ? adapter.usageSnapshot() : null;
        if (usage) providerUsage[adapter.name] = usage;
      }
      else warnings.push({ provider: adapter.name, code: result.reason?.code ?? "PROVIDER_ERROR", message: result.reason?.message ?? String(result.reason) });
    }
    if (sessions.length === 0 && warnings.length === selected.length) {
      throw new BridgeError("DISCOVERY_FAILED", warnings.map((warning) => `${warning.provider}: ${warning.message}`).join("; "));
    }
    return { sessions: sessions.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)), warnings, availableProviders, providerUsage };
  }

  route(provider, prompt, { cwd } = {}) {
    if (!this.#router) return null;
    return this.#router({ provider, prompt, cwd });
  }

  async create(provider, prompt, { cwd, routing, executionMode, executionSettings, onProgress = () => {} } = {}) {
    if (typeof prompt !== "string" || !prompt.trim()) throw new BridgeError("PROMPT_REQUIRED", "Prompt is required");
    const adapter = this.#provider(provider);
    onProgress({ message: "모델과 실행 설정 선택 중" });
    const selectedRouting = routing ?? await this.#resolveCreateRouting(provider, prompt.trim(), { cwd });
    const options = { cwd };
    if (selectedRouting?.model) options.model = selectedRouting.model;
    if (selectedRouting?.effort) options.effort = selectedRouting.effort;
    if (adapter.name === "codex" && executionMode !== undefined) options.executionMode = executionMode;
    if (executionSettings !== undefined) options.executionSettings = executionSettings;
    onProgress({ message: `${provider === "claude" ? "Claude" : "Codex"} 세션 생성 요청 중`, routing: selectedRouting });
    const created = await adapter.create(prompt.trim(), options);
    onProgress({ message: "세션 생성 접수 완료 · 목록 확인 중" });
    // Resolve real metadata only on the creating provider, without usage or unrelated providers.
    // Creation is already acknowledged: discovery failure must not offer a duplicate submission.
    try {
      const sessions = await adapter.list({ cwd });
      const session = sessions.find((candidate) => candidate.provider === provider && candidate.nativeId === created.nativeId);
      if (session) return { ...created, ...(selectedRouting ? { routing: selectedRouting } : {}), session };
    } catch { /* The regular overview refresh will discover it later. */ }
    return { ...created, ...(selectedRouting ? { routing: selectedRouting } : {}) };
  }

  async #resolveCreateRouting(provider, prompt, { cwd } = {}) {
    const resolver = this.#createRouter ?? this.#router;
    if (!resolver) return null;
    return resolver({ provider, prompt, cwd });
  }

  // Takes an already discovered identity; never rediscover or resolve by display name.
  async preview(session, options) {
    const provider = this.#provider(session.provider);
    if (typeof provider.preview !== "function") throw new BridgeError("PREVIEW_UNAVAILABLE", "Session preview is unavailable");
    return provider.preview(session, options);
  }

  async archive(target, { cwd } = {}) {
    const { provider, session } = await this.#resolve(target, cwd);
    return provider.archive(session);
  }

  async rename(target, name, { cwd } = {}) {
    if (typeof name !== "string" || !name.trim()) throw new BridgeError("NAME_REQUIRED", "Session name is required");
    const { provider, session } = await this.#resolve(target, cwd);
    return provider.rename(session, name.trim());
  }

  async send(target, message, { cwd, onProgress, waitTimeoutMs = 30 * 60_000 } = {}) {
    const { provider, session } = await this.#resolve(target, cwd);
    if (this.#requests) return this.#exchange(provider, session, message, { kind: "send", onProgress, waitTimeoutMs });
    const requestId = crypto.randomUUID();
    return provider.send(session, message, { requestId, expectsReply: false });
  }

  async ask(target, message, { cwd, waitTimeoutMs = 30 * 60 * 1_000, replyTimeoutMs = 3 * 60 * 1_000, untilIdle = false, onProgress } = {}) {
    const { provider, session } = await this.#resolve(target, cwd);
    if (this.#requests) return this.#exchange(provider, session, message, { kind: "ask", waitTimeoutMs, replyTimeoutMs, untilIdle, onProgress });
    const requestId = crypto.randomUUID();
    return provider.ask(session, message, { requestId, waitTimeoutMs, replyTimeoutMs, untilIdle, onProgress, expectsReply: true });
  }

  async #exchange(provider, session, message, options) {
    const record = this.#requests.create(session, options);
    const progress = (event) => {
      const fields = { ...event };
      delete fields.target;
      if (fields.state === "replied") fields.state = "reply-received";
      this.#requests.update(record, fields);
      options.onProgress?.({ ...event, target: session.id, requestId: record.requestId, delivery: record.delivery });
    };
    try {
      progress({ state: "not-sent", delivery: "not-sent" });
      let waitTimeoutMs = options.waitTimeoutMs;
      if (provider.name === "codex") waitTimeoutMs = await this.#requests.acquire(record, { timeoutMs: waitTimeoutMs, onProgress: progress });
      let result = await provider[options.kind](session, message, {
        ...options, waitTimeoutMs, requestId: record.requestId, onProgress: progress,
      });
      result = { ...result, delivery: result.delivery ?? record.delivery };
      if (result.reply !== undefined) result = { ...result, ...this.#requests.reply(record.requestId, { state: "replied", delivery: "accepted", reply: result.reply }) };
      const { reply, ...metadata } = result;
      if (reply !== undefined) delete record.reply;
      this.#requests.update(record, { ...metadata, state: reply !== undefined ? "replied" : result.delivery, finished: true });
      return { ...result, requestId: record.requestId };
    } catch (error) {
      if (["MESSAGE_HELD", "MESSAGE_REFUSED"].includes(error.code)) record.delivery = error.code === "MESSAGE_HELD" ? "held" : "refused";
      try { this.#requests.update(record, { finished: true, error: { code: error.code ?? "REQUEST_FAILED", message: error.message } }); }
      catch (storageError) { error.message += `; request record update failed: ${storageError.message}`; }
      Object.assign(error, { requestId: record.requestId, target: session.id, delivery: record.delivery });
      throw error;
    }
  }

  async result(requestId) {
    if (!this.#requests) throw new BridgeError("REQUEST_STORE_UNAVAILABLE", "Request storage is unavailable");
    const record = this.#requests.read(requestId);
    const base = { requestId, target: record.target, delivery: record.delivery, state: record.state, lastError: record.error, turnId: record.turnId, messageId: record.messageId };
    const cached = this.#requests.reply(requestId);
    if (cached) return { ...base, ...cached };
    if (record.state === "replied" && record.reply !== undefined) return { ...base, reply: record.reply };
    if (record.delivery === "not-sent") return { ...base, state: this.#requests.active(record) ? record.state : "not-sent" };
    if (["held", "refused"].includes(record.delivery)) return { ...base, state: record.delivery };
    if (record.kind === "send") return base;
    const provider = this.#provider(record.session.provider);
    const result = await provider.result(record);
    return { ...base, ...(result.state === "replied" ? this.#requests.reply(requestId, { ...result, delivery: "accepted" }) : result) };
  }

  async #resolve(target, cwd) {
    if (typeof target !== "string" || !target.trim()) throw new BridgeError("TARGET_REQUIRED", "Target is required");
    const hint = providerFromTarget(target);
    const { sessions, warnings } = await this.discover({ provider: hint ?? undefined, cwd });
    const matches = sessions.filter((session) => (
      session.id === target ||
      session.nativeId === target ||
      session.sessionId === target ||
      session.name === target
    ));
    if (matches.length === 0) {
      const unavailable = warnings.length ? ` (${warnings.map((warning) => `${warning.provider}: ${warning.message}`).join("; ")})` : "";
      throw new BridgeError("SESSION_NOT_FOUND", `No session matches ${target}${unavailable}`);
    }
    if (matches.length > 1) {
      throw new BridgeError("TARGET_AMBIGUOUS", `Target ${target} matches ${matches.map((session) => session.id).join(", ")}`);
    }
    return { provider: this.#provider(matches[0].provider), session: matches[0] };
  }

  #provider(name) {
    const provider = this.#providers.get(name);
    if (!provider) throw new BridgeError("PROVIDER_NOT_FOUND", `Unknown provider: ${name}`);
    return provider;
  }
}
