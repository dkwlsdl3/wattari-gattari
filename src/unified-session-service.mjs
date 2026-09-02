import { EventEmitter } from "node:events";

function providerError(provider, cause) {
  return Object.assign(new Error(`${provider} provider를 사용할 수 없습니다: ${cause?.message ?? "unknown error"}`, { cause }), {
    code: "PROVIDER_UNAVAILABLE",
  });
}

export class UnifiedSessionService extends EventEmitter {
  #providers;
  #unavailable = new Map();
  #lastSessions = new Map();
  #connected = new Set();

  constructor({ codex, claude }) {
    super();
    if (!codex || !claude) throw new TypeError("UnifiedSessionService requires codex and claude providers");
    this.#providers = new Map([["codex", codex], ["claude", claude]]);
    for (const [provider, service] of this.#providers) {
      service.on?.("changed", (event) => this.emit("changed", { provider, ...event }));
    }
  }

  async connect() {
    await this.#providers.get("codex").connect();
    this.#connected.add("codex");
    try {
      await this.#providers.get("claude").connect();
      this.#connected.add("claude");
      this.#unavailable.delete("claude");
    } catch (error) {
      this.#unavailable.set("claude", error);
    }
  }

  async detach() {
    await Promise.all([...this.#providers.values()].map((service) => Promise.resolve(service.detach?.()).catch(() => {})));
  }

  async listSessions() {
    const groups = [];
    for (const [provider, service] of this.#providers) {
      try {
        if (!this.#connected.has(provider)) {
          await service.connect();
          this.#connected.add(provider);
        }
        const sessions = await service.listSessions();
        this.#lastSessions.set(provider, sessions);
        this.#unavailable.delete(provider);
        groups.push(sessions);
      } catch (error) {
        if (provider === "codex") throw error;
        this.#unavailable.set(provider, error);
        groups.push(this.#lastSessions.get(provider) ?? []);
      }
    }
    return groups.flat().sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async createSession(options = {}) {
    const provider = options.provider ?? "codex";
    return this.#requireProvider(provider).createSession(options);
  }

  async openSession(threadId, selectedSession = null) {
    return this.#forSession(threadId, selectedSession).openSession(threadId, selectedSession);
  }

  async readSession(threadId, selectedSession = null) {
    return this.#forSession(threadId, selectedSession).readSession(threadId, selectedSession);
  }

  async loadOlderMessages(threadId, selectedSession = null) {
    return this.#forSession(threadId, selectedSession).loadOlderMessages(threadId, selectedSession);
  }

  async sendMessage(threadId, text, selectedSession = null) {
    return this.#forSession(threadId, selectedSession).sendMessage(threadId, text, selectedSession);
  }

  async executeCommand(threadId, command, argument = "", selectedSession = null) {
    return this.#forSession(threadId, selectedSession).executeCommand(threadId, command, argument, selectedSession);
  }

  async interruptSession(threadId, selectedSession = null) {
    return this.#forSession(threadId, selectedSession).interruptSession(threadId, selectedSession);
  }

  async renameSession(threadId, name, selectedSession = null) {
    return this.#forSession(threadId, selectedSession).renameSession(threadId, name, selectedSession);
  }

  async stopSession(threadId, selectedSession = null) {
    return this.#forSession(threadId, selectedSession).stopSession(threadId, selectedSession);
  }

  #forSession(threadId, selectedSession) {
    if (selectedSession?.provider) return this.#requireProvider(selectedSession.provider);
    if (typeof threadId === "string" && /^[0-9a-f]{8}$/i.test(threadId)) return this.#requireProvider("claude");
    return this.#requireProvider("codex");
  }

  #requireProvider(provider) {
    const unavailable = this.#unavailable.get(provider);
    if (unavailable || !this.#connected.has(provider)) throw providerError(provider, unavailable);
    const service = this.#providers.get(provider);
    if (!service) throw providerError(provider);
    return service;
  }
}
