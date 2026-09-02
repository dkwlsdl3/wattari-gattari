import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { UnifiedSessionService } from "../src/unified-session-service.mjs";

class FakeProvider extends EventEmitter {
  constructor(provider) {
    super();
    this.provider = provider;
    this.sessions = [{
      id: `${provider}:id`,
      threadId: `${provider}-thread`,
      provider,
      updatedAt: provider === "claude" ? 2 : 1,
    }];
    this.calls = [];
  }
  async connect() {}
  async detach() {}
  async listSessions() { return this.sessions; }
  async renameSession(threadId, name) { this.calls.push(["rename", threadId, name]); }
  async stopSession(threadId) { this.calls.push(["stop", threadId]); }
}

test("combines providers and routes metadata operations", async () => {
  const codex = new FakeProvider("codex");
  const claude = new FakeProvider("claude");
  const service = new UnifiedSessionService({ codex, claude });
  await service.connect();

  assert.deepEqual((await service.listSessions()).map(({ provider }) => provider), ["claude", "codex"]);
  await service.renameSession("claude-thread", "name", claude.sessions[0]);
  await service.stopSession("codex-thread", codex.sessions[0]);
  assert.deepEqual(claude.calls, [["rename", "claude-thread", "name"]]);
  assert.deepEqual(codex.calls.at(-1), ["stop", "codex-thread"]);
});

test("keeps Codex available when Claude cannot connect", async () => {
  const codex = new FakeProvider("codex");
  const claude = new FakeProvider("claude");
  claude.connect = async () => { throw new Error("not installed"); };
  const service = new UnifiedSessionService({ codex, claude });
  await service.connect();
  assert.deepEqual((await service.listSessions()).map(({ provider }) => provider), ["codex"]);
});
