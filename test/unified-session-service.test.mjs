import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { UnifiedSessionService } from "../src/unified-session-service.mjs";

class FakeProvider extends EventEmitter {
  constructor(provider) {
    super();
    this.provider = provider;
    this.sessions = [{ id: `${provider}:${provider === "claude" ? "abcdef12" : "uuid"}`, threadId: provider === "claude" ? "abcdef12" : "uuid", provider, updatedAt: provider === "claude" ? 2 : 1 }];
  }
  async connect() {}
  async detach() {}
  async listSessions() { return this.sessions; }
  async createSession(options) { return { provider: this.provider, options }; }
  async sendMessage(threadId, text) { return { provider: this.provider, threadId, text }; }
  async stopSession(threadId) { return { provider: this.provider, threadId }; }
}

test("combines providers and routes by selected session without id ambiguity", async () => {
  const codex = new FakeProvider("codex");
  const claude = new FakeProvider("claude");
  const service = new UnifiedSessionService({ codex, claude });
  await service.connect();
  assert.deepEqual((await service.listSessions()).map(({ provider }) => provider), ["claude", "codex"]);
  assert.equal((await service.createSession({ provider: "claude", prompt: "hi" })).provider, "claude");
  assert.equal((await service.sendMessage("uuid", "hello", codex.sessions[0])).provider, "codex");
  assert.equal((await service.sendMessage("abcdef12", "hello", claude.sessions[0])).provider, "claude");
});

test("keeps Codex available when Claude cannot connect", async () => {
  const codex = new FakeProvider("codex");
  const claude = new FakeProvider("claude");
  claude.connect = async () => { throw new Error("not installed"); };
  const service = new UnifiedSessionService({ codex, claude });
  await service.connect();
  assert.deepEqual((await service.listSessions()).map(({ provider }) => provider), ["codex"]);
  await assert.rejects(service.createSession({ provider: "claude", prompt: "hi" }), { code: "PROVIDER_UNAVAILABLE" });
});
