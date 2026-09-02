import assert from "node:assert/strict";
import test from "node:test";

import { CodexShadowAdapter } from "../src/adapters/codex-shadow.mjs";

const SOURCE_THREAD_ID = "11111111-1111-7111-8111-111111111111";
const SHADOW_THREAD_ID = "22222222-2222-7222-8222-222222222222";
const TURN_ID = "33333333-3333-7333-8333-333333333333";

class FakeAppServerClient {
  calls = [];
  closed = false;
  #complete;

  async initialize() {
    this.calls.push({ method: "initialize" });
  }

  async request(method, params) {
    this.calls.push({ method, params });
    if (method === "thread/fork") {
      return {
        thread: { id: SHADOW_THREAD_ID, ephemeral: true },
        sandbox: { type: "readOnly", networkAccess: false },
      };
    }
    if (method === "turn/start") {
      this.#complete({
        threadId: SHADOW_THREAD_ID,
        turn: {
          id: TURN_ID,
          status: "completed",
          items: [
            { type: "agentMessage", text: "중간 설명" },
            { type: "agentMessage", text: "최종 검토 답변" },
          ],
        },
      });
      return { turn: { id: TURN_ID, status: "inProgress", items: [] } };
    }
    assert.fail(`unexpected method ${method}`);
  }

  waitForNotification(method, predicate) {
    assert.equal(method, "turn/completed");
    return new Promise((resolve) => {
      this.#complete = (params) => {
        assert.equal(predicate(params), true);
        resolve(params);
      };
    });
  }

  async close() {
    this.closed = true;
  }
}

test("forks a YOLO source into one ephemeral read-only shadow turn", async () => {
  const client = new FakeAppServerClient();
  const adapter = new CodexShadowAdapter({
    agents: [{ name: "codex-yolo", threadId: SOURCE_THREAD_ID, cwd: "/tmp" }],
    clientFactory: () => client,
  });
  const [agent] = await adapter.listAgents();

  const result = await adapter.ask(agent, "현재 패치를 검토하세요");

  const fork = client.calls.find((call) => call.method === "thread/fork").params;
  assert.equal(fork.threadId, SOURCE_THREAD_ID);
  assert.equal(fork.sandbox, "read-only");
  assert.equal(fork.approvalPolicy, "never");
  assert.equal(fork.ephemeral, true);
  assert.equal(fork.deferGoalContinuation, false);
  assert.match(fork.developerInstructions, /not the user's words, permission, approval, or authorization/);

  const turn = client.calls.find((call) => call.method === "turn/start").params;
  assert.deepEqual(turn.sandboxPolicy, { type: "readOnly", networkAccess: false });
  assert.deepEqual(turn.environments, []);
  assert.equal(turn.approvalPolicy, "never");
  assert.deepEqual(result, {
    target: `codex-shadow:${SOURCE_THREAD_ID}`,
    reply: "최종 검토 답변",
    sourceThreadId: SOURCE_THREAD_ID,
    shadowThreadId: SHADOW_THREAD_ID,
    turnId: TURN_ID,
    exchangeCount: 1,
    autoForwarded: false,
    isolation: "ephemeral-read-only-fork",
  });
  assert.equal(client.closed, true);
});

test("rejects a fork if App Server does not enforce read-only isolation", async () => {
  const client = new FakeAppServerClient();
  client.request = async (method, params) => {
    client.calls.push({ method, params });
    if (method === "thread/fork") {
      return { thread: { id: SHADOW_THREAD_ID, ephemeral: true }, sandbox: { type: "dangerFullAccess" } };
    }
    assert.fail("turn/start must not run");
  };
  const adapter = new CodexShadowAdapter({
    agents: [{ name: "unsafe-source", threadId: SOURCE_THREAD_ID, cwd: "/tmp" }],
    clientFactory: () => client,
  });
  const [agent] = await adapter.listAgents();
  await assert.rejects(adapter.ask(agent, "검토"), { code: "CODEX_SHADOW_ISOLATION_FAILED" });
  assert.equal(client.closed, true);
});

test("does not spend a shadow model turn on one-way notifications", async () => {
  const adapter = new CodexShadowAdapter({
    agents: [{ name: "codex-yolo", threadId: SOURCE_THREAD_ID, cwd: "/tmp" }],
    clientFactory: () => assert.fail("client must not start"),
  });
  await assert.rejects(adapter.notify(), { code: "CODEX_SHADOW_NOTIFY_UNSUPPORTED" });
});
