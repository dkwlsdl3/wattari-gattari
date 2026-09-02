import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { FakeAdapter } from "../src/adapters/fake.mjs";
import { Broker } from "../src/broker.mjs";
import { request } from "../src/client.mjs";

function testSocket(name) {
  const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  return path.join(runtimeDir, `waga-test-${process.pid}-${name}.sock`);
}

async function fixture(t, adapter, name) {
  const socketPath = testSocket(name);
  const broker = new Broker({ socketPath, adapters: [adapter] });
  await broker.start();
  t.after(() => broker.close());
  return socketPath;
}

test("lists agents and completes a one-request one-response round trip", async (t) => {
  const fake = new FakeAdapter({ agents: [{ name: "codex2" }, { name: "claude3", serialRequests: true }] });
  const socketPath = await fixture(t, fake, "roundtrip");

  const agents = await request("list_agents", {}, { socketPath });
  assert.deepEqual(agents.map((agent) => agent.id), ["fake:codex2", "fake:claude3"]);
  assert.equal((await request("ask_agent", { target: "claude3", task: "ping", timeoutMs: 100 }, { socketPath })).reply, "echo:ping");
});

test("creates a user-only socket and refuses an unknown target", async (t) => {
  const socketPath = await fixture(t, new FakeAdapter(), "permissions");
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);
  await assert.rejects(
    request("ask_agent", { target: "missing", task: "ping", timeoutMs: 100 }, { socketPath }),
    { code: "AGENT_NOT_FOUND" },
  );
});

test("times out a slow adapter", async (t) => {
  const socketPath = await fixture(t, new FakeAdapter({ delayMs: 50 }), "timeout");
  await assert.rejects(
    request("ask_agent", { target: "fake1", task: "ping", timeoutMs: 5 }, { socketPath }),
    { code: "TIMEOUT" },
  );
});

test("serializes concurrent asks for an agent that requires it", async (t) => {
  let active = 0;
  let maxActive = 0;
  const adapter = {
    provider: "fake",
    async listAgents() {
      return [{ id: "fake:serial", name: "serial", status: "idle", serialRequests: true }];
    },
    async ask(_agent, task) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { reply: task };
    },
  };
  const socketPath = await fixture(t, adapter, "serial");
  const [first, second] = await Promise.all([
    request("ask_agent", { target: "serial", task: "first", timeoutMs: 100 }, { socketPath }),
    request("ask_agent", { target: "serial", task: "second", timeoutMs: 100 }, { socketPath }),
  ]);
  assert.deepEqual([first.reply, second.reply], ["first", "second"]);
  assert.equal(maxActive, 1);
});

test("rejects adapters that attempt multi-hop or auto-forwarded exchanges", async (t) => {
  const adapter = {
    provider: "bad",
    async listAgents() { return [{ id: "bad:one", name: "one", status: "idle" }]; },
    async ask() { return { reply: "loop", exchangeCount: 2, autoForwarded: true }; },
  };
  const socketPath = await fixture(t, adapter, "protocol-violation");
  await assert.rejects(
    request("ask_agent", { target: "one", task: "ping" }, { socketPath }),
    { code: "PEER_PROTOCOL_VIOLATION" },
  );
});

test("refuses to replace an existing socket path", async (t) => {
  const socketPath = testSocket("collision");
  const first = new Broker({ socketPath, adapters: [] });
  await first.start();
  t.after(() => first.close());
  const second = new Broker({ socketPath, adapters: [] });
  await assert.rejects(second.start(), { code: "SOCKET_EXISTS" });
});
