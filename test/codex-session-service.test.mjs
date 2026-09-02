import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexSessionService } from "../src/codex-session-service.mjs";
import { ManagedThreadCatalog } from "../src/managed-thread-catalog.mjs";

const THREAD_ID = "11111111-1111-7111-8111-111111111111";
const TURN_ID = "22222222-2222-7222-8222-222222222222";

function catalogPath(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-codex-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  return path.join(directory, "catalog.json");
}

class FakeBackend {
  active = [];
  archived = [];
  turns = new Map();
  requests = [];
  notifications = new Set();

  client(options) {
    const backend = this;
    const listener = options.onNotification;
    if (listener) this.notifications.add(listener);
    return {
      async initialize() {},
      async request(method, params) {
        backend.requests.push({ method, params });
        if (method === "account/rateLimits/read") return { rateLimits: { primary: { usedPercent: 10 } } };
        if (method === "thread/list") return { data: params.archived ? backend.archived : backend.active, nextCursor: null };
        if (method === "thread/name/set") {
          [...backend.active, ...backend.archived].find((thread) => thread.id === params.threadId).name = params.name;
          return {};
        }
        if (method === "thread/turns/list") return { data: backend.turns.get(params.threadId), nextCursor: null };
        if (method === "turn/interrupt") {
          backend.turns.get(params.threadId).find((turn) => turn.id === params.turnId).status = "interrupted";
          return {};
        }
        if (method === "thread/archive") {
          const index = backend.active.findIndex((thread) => thread.id === params.threadId);
          const [thread] = backend.active.splice(index, 1);
          backend.archived.push(thread);
          return {};
        }
        assert.fail(`unexpected method ${method}`);
      },
      async close() {
        backend.notifications.delete(listener);
      },
    };
  }

  notify(message) {
    for (const listener of this.notifications) listener(message);
  }
}

function serviceFor(t, backend, file = catalogPath(t)) {
  return new CodexSessionService({
    cwd: "/workspace",
    socketPath: "/runtime/codex.sock",
    catalogPath: file,
    clientFactory: (options) => backend.client(options),
  });
}

test("adopts a native Codex thread announced on the managed socket", async (t) => {
  const backend = new FakeBackend();
  const file = catalogPath(t);
  const service = serviceFor(t, backend, file);
  await service.connect();
  const thread = {
    id: THREAD_ID,
    name: null,
    preview: "",
    cwd: "/workspace",
    updatedAt: 1,
    status: { type: "idle" },
    threadSource: "user",
  };
  backend.active.push(thread);
  backend.notify({ method: "thread/started", params: { thread } });

  assert.equal((await service.listSessions())[0].status, "Awaiting input");
  assert.equal(new ManagedThreadCatalog(file).read().has(THREAD_ID), true);
  assert.equal(backend.requests.some(({ method }) => method === "thread/start"), false);
});

test("lists only managed workspace threads and adopts the legacy source", async (t) => {
  const backend = new FakeBackend();
  backend.active.push(
    { id: THREAD_ID, name: "legacy", preview: "", cwd: "/workspace", updatedAt: 2, status: { type: "idle" }, threadSource: "agent-bus" },
    { id: "33333333-3333-7333-8333-333333333333", name: "foreign", preview: "", cwd: "/workspace", updatedAt: 1, status: { type: "idle" }, threadSource: "cli" },
  );
  const file = catalogPath(t);
  const service = serviceFor(t, backend, file);
  await service.connect();

  assert.deepEqual((await service.listSessions()).map(({ threadId }) => threadId), [THREAD_ID]);
  assert.equal(new ManagedThreadCatalog(file).read().has(THREAD_ID), true);
  const list = backend.requests.find(({ method }) => method === "thread/list");
  assert.equal(list.params.cwd, "/workspace");
  assert.equal(list.params.useStateDbOnly, true);
});

test("reflects native turn notifications without rendering the conversation", async (t) => {
  const backend = new FakeBackend();
  const file = catalogPath(t);
  const service = serviceFor(t, backend, file);
  backend.active.push({
    id: THREAD_ID, name: null, preview: "", cwd: "/workspace", updatedAt: 1,
    status: { type: "idle" }, threadSource: "user",
  });
  new ManagedThreadCatalog(file).record(THREAD_ID);
  await service.connect();

  backend.notify({ method: "turn/started", params: { threadId: THREAD_ID, turn: { id: TURN_ID, startedAt: 10 } } });
  backend.notify({ method: "thread/tokenUsage/updated", params: { threadId: THREAD_ID, tokenUsage: { total: { totalTokens: 123 } } } });
  let [session] = await service.listSessions();
  assert.equal(session.status, "Working");
  assert.equal(session.workingSince, 10_000);
  assert.equal(session.tokenUsage.total.totalTokens, 123);

  backend.notify({ method: "turn/completed", params: { threadId: THREAD_ID, turn: { id: TURN_ID } } });
  [session] = await service.listSessions();
  assert.equal(session.status, "Awaiting input");
  assert.equal(session.activeTurnId, null);
});

test("renames and stops a managed thread, interrupting an active native turn first", async (t) => {
  const backend = new FakeBackend();
  const file = catalogPath(t);
  const service = serviceFor(t, backend, file);
  backend.active.push({
    id: THREAD_ID, name: null, preview: "", cwd: "/workspace", updatedAt: 1,
    status: { type: "idle" }, threadSource: "user",
  });
  backend.turns.set(THREAD_ID, []);
  new ManagedThreadCatalog(file).record(THREAD_ID);
  await service.connect();
  await service.renameSession(THREAD_ID, "renamed");
  backend.turns.set(THREAD_ID, [{ id: TURN_ID, status: "inProgress" }]);

  await service.stopSession(THREAD_ID);

  assert.deepEqual(backend.requests.slice(-3).map(({ method }) => method), [
    "thread/turns/list",
    "turn/interrupt",
    "thread/archive",
  ]);
  assert.deepEqual(await service.listSessions(), []);
  assert.deepEqual([...new ManagedThreadCatalog(file).read()], []);
});

test("prunes a catalog entry after native Codex archives it", async (t) => {
  const backend = new FakeBackend();
  const file = catalogPath(t);
  new ManagedThreadCatalog(file).record(THREAD_ID);
  backend.archived.push({ id: THREAD_ID, name: "old", preview: "", cwd: "/workspace", updatedAt: 1, status: { type: "notLoaded" }, threadSource: "waga" });
  const service = serviceFor(t, backend, file);
  await service.connect();

  assert.deepEqual(await service.listSessions(), []);
  assert.deepEqual([...new ManagedThreadCatalog(file).read()], []);
  await service.detach();
});

test("prunes a catalog entry when native Codex exits before persisting a first turn", async (t) => {
  const backend = new FakeBackend();
  const file = catalogPath(t);
  new ManagedThreadCatalog(file).record(THREAD_ID);
  const service = serviceFor(t, backend, file);
  await service.connect();

  assert.deepEqual(await service.listSessions(), []);
  assert.deepEqual([...new ManagedThreadCatalog(file).read()], []);
});
