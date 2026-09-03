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

  constructor({ providers }) {
    if (!Array.isArray(providers) || providers.length === 0) {
      throw new TypeError("SessionBridge requires at least one provider");
    }
    this.#providers = new Map(providers.map((provider) => [provider.name, provider]));
  }

  async discover({ provider, cwd } = {}) {
    const selected = provider ? [this.#provider(provider)] : [...this.#providers.values()];
    const results = await Promise.allSettled(selected.map((adapter) => adapter.list({ cwd })));
    const sessions = [];
    const warnings = [];
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const adapter = selected[index];
      if (result.status === "fulfilled") sessions.push(...result.value);
      else warnings.push({ provider: adapter.name, code: result.reason?.code ?? "PROVIDER_ERROR", message: result.reason?.message ?? String(result.reason) });
    }
    if (sessions.length === 0 && warnings.length === selected.length) {
      throw new BridgeError("DISCOVERY_FAILED", warnings.map((warning) => `${warning.provider}: ${warning.message}`).join("; "));
    }
    return { sessions: sessions.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)), warnings };
  }

  async create(provider, prompt, { cwd } = {}) {
    if (typeof prompt !== "string" || !prompt.trim()) throw new BridgeError("PROMPT_REQUIRED", "Prompt is required");
    return this.#provider(provider).create(prompt.trim(), { cwd });
  }

  async archive(target, { cwd } = {}) {
    const { provider, session } = await this.#resolve(target, cwd);
    return provider.archive(session);
  }

  async send(target, message, { cwd } = {}) {
    const { provider, session } = await this.#resolve(target, cwd);
    const requestId = crypto.randomUUID();
    return provider.send(session, message, { requestId, expectsReply: false });
  }

  async ask(target, message, { cwd, waitTimeoutMs = 30 * 60 * 1_000, replyTimeoutMs = 3 * 60 * 1_000, onProgress } = {}) {
    const { provider, session } = await this.#resolve(target, cwd);
    const requestId = crypto.randomUUID();
    return provider.ask(session, message, { requestId, waitTimeoutMs, replyTimeoutMs, onProgress, expectsReply: true });
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
