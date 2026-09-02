import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { APPROVAL_GATE_PATH } from "../src/codex-app-server.mjs";
import { CodexSessionService } from "../src/codex-session-service.mjs";
import { ManagedThreadCatalog } from "../src/managed-thread-catalog.mjs";

const THREAD_ID = "11111111-1111-7111-8111-111111111111";
const SECOND_THREAD_ID = "33333333-3333-7333-8333-333333333333";
const TURN_ID = "22222222-2222-7222-8222-222222222222";

function testCatalogPath(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-catalog-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  return path.join(directory, "codex-sessions.json");
}

class FakeBackend {
  active = [];
  archived = [];
  items = new Map();
  turns = new Map();
  notifications = new Set();
  mcpStatuses = [];
  sandbox = { type: "readOnly", networkAccess: false };
  approvalHook = false;
  hideActiveFromList = false;
  itemListHandler = null;
  requests = [];
  lastClientOptions = null;
  nextThreadIndex = 0;

  client(options) {
    const backend = this;
    this.lastClientOptions = options;
    const listener = options.onNotification;
    if (listener) this.notifications.add(listener);
    return {
      closed: false,
      async initialize() {},
      async request(method, params) {
        backend.requests.push({ method, params });
        if (method === "mcpServerStatus/list") return { data: backend.mcpStatuses, nextCursor: null };
        if (method === "account/rateLimits/read") {
          return {
            rateLimits: {
              primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1_800_000_000 },
              secondary: { usedPercent: 40, windowDurationMins: 10_080, resetsAt: 1_800_000_000 },
            },
          };
        }
        if (method === "model/list") {
          return {
            data: [{
              id: "gpt-test",
              model: "gpt-test",
              displayName: "GPT Test",
              isDefault: true,
              serviceTiers: [{ id: "priority", name: "Fast" }],
            }],
            nextCursor: null,
          };
        }
        if (method === "thread/compact/start") return {};
        if (method === "skills/list") return { data: [{ cwd: "/workspace", skills: [{ name: "test-skill" }] }] };
        if (method === "hooks/list") {
          return {
            data: [{
              cwd: params.cwds[0],
              hooks: backend.approvalHook ? [{
                eventName: "preToolUse",
                handlerType: "command",
                command: `node ${JSON.stringify(APPROVAL_GATE_PATH)}`,
                matcher: "^(Bash|apply_patch|write_stdin|request_permissions)$",
                async: false,
                enabled: true,
                source: "sessionFlags",
              }] : [],
              warnings: [],
              errors: [],
            }],
          };
        }
        if (method === "thread/list") {
          const active = backend.hideActiveFromList ? [] : backend.active;
          return { data: params.archived ? backend.archived : active, nextCursor: null };
        }
        if (method === "thread/start") {
          const threadId = [THREAD_ID, SECOND_THREAD_ID][backend.nextThreadIndex++];
          assert.ok(threadId, "fake backend ran out of thread ids");
          const thread = {
            id: threadId,
            name: null,
            preview: "",
            cwd: params.cwd,
            updatedAt: 1,
            status: { type: "idle" },
            threadSource: null,
          };
          backend.active.push(thread);
          backend.items.set(threadId, []);
          backend.turns.set(threadId, []);
          return { thread: { ...thread, threadSource: params.threadSource }, sandbox: backend.sandbox };
        }
        if (method === "thread/fork") {
          const source = backend.active.find((item) => item.id === params.threadId);
          const thread = {
            ...source,
            id: SECOND_THREAD_ID,
            name: null,
            status: { type: "idle" },
            threadSource: params.threadSource,
          };
          backend.active.push(thread);
          backend.items.set(thread.id, [...backend.items.get(source.id)]);
          backend.turns.set(thread.id, [...backend.turns.get(source.id)]);
          return {
            thread,
            sandbox: backend.sandbox,
            approvalPolicy: params.approvalPolicy,
            approvalsReviewer: params.approvalsReviewer,
            cwd: params.cwd,
            model: "gpt-test",
            modelProvider: "openai",
            reasoningEffort: "high",
            serviceTier: null,
          };
        }
        if (method === "thread/name/set") {
          const thread = [...backend.active, ...backend.archived].find((item) => item.id === params.threadId);
          thread.name = params.name;
          return {};
        }
        if (method === "thread/resume") {
          const thread = backend.active.find((item) => item.id === params.threadId);
          if (thread.status.type !== "active") thread.status = { type: "idle" };
          return {
            thread,
            sandbox: backend.sandbox,
            model: "gpt-test",
            modelProvider: "openai",
            reasoningEffort: "high",
            serviceTier: "priority",
          };
        }
        if (method === "turn/start") {
          const thread = backend.active.find((item) => item.id === params.threadId);
          thread.status = { type: "active", activeFlags: [] };
          thread.preview ||= params.input[0].text;
          const turn = { id: TURN_ID, status: "inProgress", items: [] };
          backend.turns.get(params.threadId).unshift(turn);
          backend.items.get(params.threadId).push({
            turnId: TURN_ID,
            item: { id: "user-1", type: "userMessage", content: params.input },
          });
          return { turn };
        }
        if (method === "turn/steer") {
          const turn = backend.turns.get(params.threadId).find((item) => item.id === params.expectedTurnId);
          assert.equal(turn.status, "inProgress");
          backend.items.get(params.threadId).push({
            turnId: turn.id,
            item: { id: `user-${backend.items.get(params.threadId).length + 1}`, type: "userMessage", content: params.input },
          });
          return { turnId: turn.id };
        }
        if (method === "thread/items/list") {
          if (backend.itemListHandler) return backend.itemListHandler(params);
          const data = backend.items.get(params.threadId);
          return {
            data: params.sortDirection === "desc" ? [...data].reverse() : data,
            nextCursor: null,
          };
        }
        if (method === "thread/turns/list") {
          return { data: backend.turns.get(params.threadId), nextCursor: null };
        }
        if (method === "turn/interrupt") {
          const turn = backend.turns.get(params.threadId).find((item) => item.id === params.turnId);
          turn.status = "interrupted";
          return {};
        }
        if (method === "thread/archive") {
          const index = backend.active.findIndex((item) => item.id === params.threadId);
          const [thread] = backend.active.splice(index, 1);
          thread.status = { type: "notLoaded" };
          backend.archived.push(thread);
          return {};
        }
        assert.fail(`unexpected method ${method}`);
      },
      async close() {
        if (listener) backend.notifications.delete(listener);
        this.closed = true;
      },
    };
  }

  complete(text = "READY", threadId = this.active[0].id) {
    const thread = this.active.find((entry) => entry.id === threadId);
    const turn = this.turns.get(thread.id)[0];
    turn.status = "completed";
    thread.status = { type: "idle" };
    this.items.get(thread.id).push({
      turnId: turn.id,
      item: { id: "agent-1", type: "agentMessage", text },
    });
    for (const listener of this.notifications) {
      listener({ method: "turn/completed", params: { threadId: thread.id, turn } });
    }
  }
}

test("creates and manages multiple Codex sessions independently", async (t) => {
  const backend = new FakeBackend();
  const catalogPath = testCatalogPath(t);
  const service = new CodexSessionService({
    cwd: "/workspace",
    catalogPath,
    clientFactory: (options) => backend.client(options),
  });
  await service.connect();

  const first = await service.createSession({ prompt: "첫 작업" });
  const second = await service.createSession({ prompt: "둘째 작업" });

  assert.deepEqual([first.threadId, second.threadId], [THREAD_ID, SECOND_THREAD_ID]);
  assert.deepEqual(new Set((await service.listSessions()).map(({ threadId }) => threadId)), new Set([
    THREAD_ID,
    SECOND_THREAD_ID,
  ]));
  await service.stopSession(THREAD_ID);
  assert.deepEqual((await service.listSessions()).map(({ threadId }) => threadId), [SECOND_THREAD_ID]);
  assert.deepEqual([...new ManagedThreadCatalog(catalogPath).read()], [SECOND_THREAD_ID]);
});

test("keeps a managed thread visible after the screen client detaches and reconnects", async (t) => {
  const backend = new FakeBackend();
  const catalogPath = testCatalogPath(t);
  const first = new CodexSessionService({
    cwd: "/workspace",
    catalogPath,
    clientFactory: (options) => backend.client(options),
  });
  await first.connect();
  const created = await first.createSession({ prompt: "READY라고 답하세요" });
  assert.equal(created.threadId, THREAD_ID);
  assert.equal(created.status, "Working");
  backend.complete();
  await first.detach();

  backend.active[0].status = { type: "notLoaded" };
  const second = new CodexSessionService({
    cwd: "/workspace",
    catalogPath,
    clientFactory: (options) => backend.client(options),
  });
  await second.connect();
  assert.equal((await second.listSessions())[0].status, "Sleeping");
  const reopened = await second.openSession(THREAD_ID);
  assert.equal(reopened.status, "Awaiting input");
  assert.deepEqual(reopened.messages.map(({ role, text }) => ({ role, text })), [
    { role: "user", text: "READY라고 답하세요" },
    { role: "agent", text: "READY" },
  ]);
});

test("steers and interrupts the active Codex turn instead of rejecting mid-turn input", async (t) => {
  const backend = new FakeBackend();
  const service = new CodexSessionService({
    cwd: "/workspace",
    catalogPath: testCatalogPath(t),
    clientFactory: (options) => backend.client(options),
  });
  await service.connect();
  const created = await service.createSession({ prompt: "처음 지시" });

  const steered = await service.sendMessage(created.threadId, "테스트부터 보세요");
  assert.deepEqual(steered, { id: TURN_ID, status: "inProgress" });
  const steer = backend.requests.find((entry) => entry.method === "turn/steer");
  assert.equal(steer.params.expectedTurnId, TURN_ID);
  assert.equal(steer.params.input[0].text, "테스트부터 보세요");

  const interrupted = await service.interruptSession(created.threadId);
  assert.deepEqual(interrupted, { interrupted: true, threadId: THREAD_ID, turnId: TURN_ID });
  assert.equal(backend.turns.get(THREAD_ID)[0].status, "interrupted");
  assert.equal((await service.listSessions())[0].status, "Awaiting input");
});

test("executes Codex App Server slash commands and applies model settings to later turns", async (t) => {
  const backend = new FakeBackend();
  const catalogPath = testCatalogPath(t);
  const service = new CodexSessionService({
    cwd: "/workspace",
    catalogPath,
    clientFactory: (options) => backend.client(options),
  });
  await service.connect();
  const created = await service.createSession({ prompt: "first" });
  backend.complete();

  assert.match((await service.executeCommand(created.threadId, "/model", "gpt-test")).message, /GPT Test/);
  assert.match((await service.executeCommand(created.threadId, "/effort", "xhigh")).message, /xhigh/);
  assert.match((await service.executeCommand(created.threadId, "/fast", "on")).message, /Fast/);
  assert.match((await service.executeCommand(created.threadId, "/personality", "pragmatic")).message, /pragmatic/);
  assert.match((await service.executeCommand(created.threadId, "/permissions")).message, /read-only/);
  assert.match((await service.executeCommand(created.threadId, "/compact")).message, /압축/);
  assert.match((await service.executeCommand(created.threadId, "/skills")).message, /test-skill/);
  const forked = await service.executeCommand(created.threadId, "/fork", "alternate");
  assert.equal(forked.session.threadId, SECOND_THREAD_ID);
  assert.equal(forked.session.name, "alternate");
  assert.deepEqual([...new ManagedThreadCatalog(catalogPath).read()], [THREAD_ID, SECOND_THREAD_ID]);

  await service.sendMessage(created.threadId, "next");
  const turn = backend.requests.findLast(({ method }) => method === "turn/start");
  assert.equal(turn.params.model, "gpt-test");
  assert.equal(turn.params.effort, "xhigh");
  assert.equal(turn.params.serviceTier, "priority");
  assert.equal(turn.params.personality, "pragmatic");
});

test("publishes real model, context, git, rate-limit, and working-time metadata", async (t) => {
  const backend = new FakeBackend();
  const service = new CodexSessionService({
    cwd: "/workspace",
    catalogPath: testCatalogPath(t),
    clientFactory: (options) => backend.client(options),
  });
  await service.connect();
  const created = await service.createSession({ prompt: "상태 확인" });
  backend.active[0].gitInfo = { branch: "main", sha: "abc123", originUrl: null };
  await service.openSession(created.threadId, created);
  for (const listener of backend.notifications) {
    listener({
      method: "thread/tokenUsage/updated",
      params: {
        threadId: THREAD_ID,
        turnId: TURN_ID,
        tokenUsage: {
          last: { totalTokens: 10_000 },
          total: { totalTokens: 12_000 },
          modelContextWindow: 200_000,
        },
      },
    });
    listener({
      method: "account/rateLimits/updated",
      params: { rateLimits: { primary: { usedPercent: 25 } } },
    });
  }

  const [session] = await service.listSessions();
  assert.equal(session.model, "gpt-test");
  assert.equal(session.reasoningEffort, "high");
  assert.equal(session.serviceTier, "priority");
  assert.equal(session.gitBranch, "main");
  assert.equal(session.tokenUsage.last.totalTokens, 10_000);
  assert.equal(session.rateLimits.secondary.usedPercent, 40);
  assert.equal(session.rateLimits.primary.usedPercent, 25);
  assert.equal(session.rateLimits.primary.windowDurationMins, 300);
  assert.equal(typeof session.workingSince, "number");
  assert.equal(session.activeTurnId, TURN_ID);
});

test("opens a selected session without relisting all threads", async (t) => {
  const backend = new FakeBackend();
  const service = new CodexSessionService({
    cwd: "/workspace",
    catalogPath: testCatalogPath(t),
    clientFactory: (options) => backend.client(options),
  });
  await service.connect();
  const selected = await service.createSession({ prompt: "READY라고 답하세요" });
  backend.requests = [];

  const opened = await service.openSession(THREAD_ID, selected);

  assert.equal(opened.threadId, THREAD_ID);
  assert.equal(backend.requests.filter(({ method }) => method === "thread/list").length, 0);
  assert.equal(backend.requests.filter(({ method }) => method === "thread/items/list").length, 1);
});

test("lists only the current workspace from the fast state database", async (t) => {
  const backend = new FakeBackend();
  const service = new CodexSessionService({
    cwd: "/workspace",
    catalogPath: testCatalogPath(t),
    clientFactory: (options) => backend.client(options),
  });
  await service.connect();
  await service.listSessions();

  const list = backend.requests.find(({ method }) => method === "thread/list");
  assert.equal(list.params.cwd, "/workspace");
  assert.equal(list.params.useStateDbOnly, true);
});

test("caches the recent transcript, merges new messages, and pages older history", async (t) => {
  const backend = new FakeBackend();
  const entry = (id, type, text) => ({
    turnId: `${id}-turn`,
    item: type === "userMessage"
      ? { id, type, content: [{ type: "text", text }] }
      : { id, type, text },
  });
  let latest = [
    entry("agent-3", "agentMessage", "셋"),
    entry("user-2", "userMessage", "둘"),
  ];
  backend.itemListHandler = ({ cursor, limit, sortDirection }) => {
    assert.equal(limit, 100);
    assert.equal(sortDirection, "desc");
    if (cursor === "older-page") {
      return {
        data: [entry("agent-1", "agentMessage", "하나 답"), entry("user-1", "userMessage", "하나")],
        nextCursor: null,
      };
    }
    assert.equal(cursor, undefined);
    return { data: latest, nextCursor: "older-page" };
  };
  const service = new CodexSessionService({
    cwd: "/workspace",
    catalogPath: testCatalogPath(t),
    clientFactory: (options) => backend.client(options),
  });
  await service.connect();
  const selected = await service.createSession({ prompt: "READY라고 답하세요" });

  let detail = await service.openSession(THREAD_ID, selected);
  assert.deepEqual(detail.messages.map(({ id, text }) => ({ id, text })), [
    { id: "user-2", text: "둘" },
    { id: "agent-3", text: "셋" },
  ]);
  assert.equal(detail.hasOlderMessages, true);

  latest = [
    entry("agent-4", "agentMessage", "넷"),
    entry("agent-3", "agentMessage", "셋"),
    entry("user-2", "userMessage", "둘"),
  ];
  detail = await service.readSession(THREAD_ID, detail);
  assert.deepEqual(detail.messages.map(({ id, text }) => ({ id, text })), [
    { id: "user-2", text: "둘" },
    { id: "agent-3", text: "셋" },
    { id: "agent-4", text: "넷" },
  ]);

  detail = await service.loadOlderMessages(THREAD_ID, detail);
  assert.deepEqual(detail.messages.map(({ id, text }) => ({ id, text })), [
    { id: "user-1", text: "하나" },
    { id: "agent-1", text: "하나 답" },
    { id: "user-2", text: "둘" },
    { id: "agent-3", text: "셋" },
    { id: "agent-4", text: "넷" },
  ]);
  assert.equal(detail.hasOlderMessages, false);

  latest = [
    entry("agent-5", "agentMessage", "다섯"),
    entry("agent-4", "agentMessage", "넷"),
    entry("agent-3", "agentMessage", "셋"),
  ];
  detail = await service.readSession(THREAD_ID, detail);
  assert.deepEqual(detail.messages.map(({ id }) => id), [
    "user-1",
    "agent-1",
    "user-2",
    "agent-3",
    "agent-4",
    "agent-5",
  ]);
});

test("serializes recent refresh with older-history pagination", async (t) => {
  const backend = new FakeBackend();
  const entry = (id, text) => ({
    turnId: `${id}-turn`,
    item: { id, type: "agentMessage", text },
  });
  let latest = [entry("agent-2", "둘")];
  backend.itemListHandler = async ({ cursor }) => {
    if (cursor === "older-page") {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { data: [entry("agent-1", "하나")], nextCursor: null };
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { data: latest, nextCursor: "older-page" };
  };
  const service = new CodexSessionService({
    cwd: "/workspace",
    catalogPath: testCatalogPath(t),
    clientFactory: (options) => backend.client(options),
  });
  await service.connect();
  const selected = await service.createSession({ prompt: "READY라고 답하세요" });
  const initial = await service.openSession(THREAD_ID, selected);
  latest = [entry("agent-3", "셋"), entry("agent-2", "둘")];

  const recent = service.readSession(THREAD_ID, initial);
  const older = service.loadOlderMessages(THREAD_ID, initial);
  await recent;
  const finalDetail = await older;

  assert.deepEqual(finalDetail.messages.map(({ id }) => id), ["agent-1", "agent-2", "agent-3"]);
});

test("bounds an unattended transcript cache to the latest page", async (t) => {
  const backend = new FakeBackend();
  let batch = 0;
  backend.itemListHandler = ({ limit }) => ({
    data: Array.from({ length: limit }, (_, index) => ({
      turnId: `turn-${batch}-${index}`,
      item: { id: `agent-${batch}-${index}`, type: "agentMessage", text: `message ${batch}-${index}` },
    })),
    nextCursor: "older-page",
  });
  const service = new CodexSessionService({
    cwd: "/workspace",
    catalogPath: testCatalogPath(t),
    clientFactory: (options) => backend.client(options),
  });
  await service.connect();
  const selected = await service.createSession({ prompt: "READY라고 답하세요" });
  let detail = await service.openSession(THREAD_ID, selected);

  for (batch = 1; batch <= 20; batch += 1) {
    detail = await service.readSession(THREAD_ID, detail);
  }

  assert.equal(detail.messages.length, 100);
  assert.equal(detail.hasOlderMessages, true);
});

test("keeps a newly created thread approved while thread/list visibility catches up", async (t) => {
  const backend = new FakeBackend();
  backend.hideActiveFromList = true;
  const catalogPath = testCatalogPath(t);
  const service = new CodexSessionService({
    cwd: "/workspace",
    catalogPath,
    clientFactory: (options) => backend.client(options),
  });
  await service.connect();
  await service.createSession({ prompt: "표식 파일을 삭제하세요" });

  assert.deepEqual(await service.listSessions(), []);
  assert.equal(service.catalog.read().has(THREAD_ID), true);

  backend.hideActiveFromList = false;
  assert.equal((await service.listSessions())[0].threadId, THREAD_ID);
});

test("explicit stop removes the session from the managed list without deleting its transcript", async (t) => {
  const backend = new FakeBackend();
  const catalogPath = testCatalogPath(t);
  const service = new CodexSessionService({
    cwd: "/workspace",
    catalogPath,
    clientFactory: (options) => backend.client(options),
  });
  await service.connect();
  await service.createSession({ prompt: "오래 작업하세요" });
  await service.stopSession(THREAD_ID);
  assert.deepEqual(await service.listSessions(), []);
  await assert.rejects(service.readSession(THREAD_ID), { code: "SESSION_NOT_FOUND" });
  assert.equal(backend.items.get(THREAD_ID)[0].item.content[0].text, "오래 작업하세요");
  assert.equal(backend.turns.get(THREAD_ID)[0].status, "interrupted");
  assert.deepEqual([...service.catalog.read()], []);
});

test("prunes a legacy stopped thread from the managed catalog", async (t) => {
  const backend = new FakeBackend();
  const catalogPath = testCatalogPath(t);
  const catalog = new ManagedThreadCatalog(catalogPath);
  catalog.record(THREAD_ID);
  backend.archived.push({
    id: THREAD_ID,
    name: "과거 종료 세션",
    preview: "완료",
    cwd: "/workspace",
    updatedAt: 1,
    status: { type: "notLoaded" },
    threadSource: null,
  });
  const service = new CodexSessionService({
    cwd: "/workspace",
    catalogPath,
    clientFactory: (options) => backend.client(options),
  });
  await service.connect();

  assert.deepEqual(await service.listSessions(), []);
  assert.deepEqual([...catalog.read()], []);
});

test("adopts an active thread created under the former agent-bus source", async (t) => {
  const backend = new FakeBackend();
  const catalogPath = testCatalogPath(t);
  backend.active.push({
    id: THREAD_ID,
    name: "이전 이름 세션",
    preview: "계속 작업",
    cwd: "/workspace",
    updatedAt: 1,
    status: { type: "idle" },
    threadSource: "agent-bus",
  });
  const service = new CodexSessionService({
    cwd: "/workspace",
    catalogPath,
    clientFactory: (options) => backend.client(options),
  });
  await service.connect();

  assert.equal((await service.listSessions())[0].threadId, THREAD_ID);
  assert.equal(service.catalog.read().has(THREAD_ID), true);
});

test("refuses a daemon that exposes external MCP capabilities", async (t) => {
  const backend = new FakeBackend();
  backend.mcpStatuses = [{
    name: "playwright",
    runtimeStatus: { state: "ready" },
    tools: { click: {} },
    resources: [],
    resourceTemplates: [],
  }];
  const service = new CodexSessionService({
    catalogPath: testCatalogPath(t),
    clientFactory: (options) => backend.client(options),
  });
  await assert.rejects(service.connect(), { code: "EXTERNAL_MCP_ENABLED" });
});

test("accepts configured MCP entries whose thread runtime is explicitly disabled", async (t) => {
  const backend = new FakeBackend();
  backend.mcpStatuses = [{
    name: "playwright",
    runtimeStatus: "disabled",
    tools: {},
    resources: [],
    resourceTemplates: [],
  }];
  const service = new CodexSessionService({
    catalogPath: testCatalogPath(t),
    clientFactory: (options) => backend.client(options),
  });
  await service.connect();
  await service.detach();
});

test("enables workspace writes only when the exact direct-approval hook is present", async (t) => {
  const backend = new FakeBackend();
  backend.approvalHook = true;
  backend.sandbox = { type: "workspaceWrite", writableRoots: [], networkAccess: false };
  const service = new CodexSessionService({
    cwd: "/home/test/Projects/wattari-gattari",
    catalogPath: testCatalogPath(t),
    clientFactory: (options) => backend.client(options),
  });
  await service.connect();
  assert.equal(service.workspaceWriteEnabled, true);
  await service.createSession({ prompt: "파일을 수정하세요" });

  const start = backend.requests.find((entry) => entry.method === "thread/start").params;
  assert.equal(start.sandbox, "workspace-write");
  assert.deepEqual(start.config, { bypass_hook_trust: true });
  assert.equal("environments" in start, false);
  const turn = backend.requests.find((entry) => entry.method === "turn/start").params;
  assert.equal(turn.sandboxPolicy.type, "workspaceWrite");
  assert.equal(turn.sandboxPolicy.networkAccess, false);
  assert.equal("environments" in turn, false);
});

test("writable managed turns use on-request and forward the host approval callback", async (t) => {
  const backend = new FakeBackend();
  backend.approvalHook = true;
  backend.sandbox = { type: "workspaceWrite", writableRoots: [], networkAccess: false };
  const onServerRequest = async () => ({ decision: "accept" });
  const service = new CodexSessionService({
    cwd: "/home/test/Projects/wattari-gattari",
    catalogPath: testCatalogPath(t),
    clientFactory: (options) => backend.client(options),
    onServerRequest,
  });
  await service.connect();
  await service.createSession({ prompt: "파일을 수정하세요" });

  assert.equal(backend.lastClientOptions.onServerRequest, onServerRequest);
  assert.equal(backend.requests.find((entry) => entry.method === "thread/start").params.approvalPolicy, "on-request");
  assert.equal(backend.requests.find((entry) => entry.method === "turn/start").params.approvalPolicy, "on-request");
});
