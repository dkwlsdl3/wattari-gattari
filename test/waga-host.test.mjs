import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WagaHost } from "../src/waga-host.mjs";
import { DirectApprovalLedger } from "../src/direct-approval-ledger.mjs";
import { WorkspaceRegistry } from "../src/workspace-registry.mjs";

class FakeSessionService extends EventEmitter {
  constructor(workspacePath) {
    super();
    this.workspacePath = workspacePath;
    this.sessions = [];
    this.nextId = 1;
  }

  async connect() {}
  async detach() {}
  async listSessions() { return structuredClone(this.sessions); }
  async createSession({ prompt }) {
    const threadId = `${this.workspacePath}-${this.nextId++}`;
    const session = {
      id: `codex:${threadId}`,
      threadId,
      provider: "codex",
      name: prompt,
      cwd: this.workspacePath,
      status: "Working",
      lastActivity: prompt,
      updatedAt: this.nextId,
    };
    this.sessions.push(session);
    return structuredClone(session);
  }
  async stopSession(threadId) {
    this.sessions = this.sessions.filter((session) => session.threadId !== threadId);
  }
  async interruptSession(threadId) {
    const session = this.sessions.find((candidate) => candidate.threadId === threadId);
    if (session) session.status = "Awaiting input";
    return { interrupted: true, threadId };
  }
}

class FakeApprovalServer extends EventEmitter {
  resolved = [];
  async start() {}
  async close() {}
  resolve(requestId, decision) {
    this.resolved.push({ requestId, decision });
    this.emit("resolved", { requestId, decision });
    return true;
  }
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-host-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const services = new Map();
  const registry = new WorkspaceRegistry(path.join(directory, "workspaces.json"));
  const approvalServer = new FakeApprovalServer();
  const approvalLedger = new DirectApprovalLedger();
  const host = new WagaHost({
    registry,
    approvalServer,
    approvalLedger,
    sessionFactory: (workspacePath) => {
      const service = new FakeSessionService(workspacePath);
      services.set(workspacePath, service);
      return service;
    },
  });
  t.after(() => host.close());
  return { host, registry, services, approvalServer };
}

test("aggregates empty workspaces and multiple sessions into one shared snapshot", async (t) => {
  const { host } = fixture(t);
  await host.start();
  const states = [];
  host.on("state", (state) => states.push(state));
  await host.dispatch("workspace/register", { path: "/workspace/sample-app" });
  await host.dispatch("workspace/register", { path: "/workspace/docs-site" });
  assert.deepEqual(states.at(-1).workspaces.map(({ name }) => name), ["sample-app", "docs-site"]);
  const first = await host.dispatch("session/create", { workspacePath: "/workspace/sample-app", prompt: "first" });
  const second = await host.dispatch("session/create", { workspacePath: "/workspace/sample-app", prompt: "second" });

  const state = host.snapshot();
  assert.deepEqual(state.workspaces.map(({ name, sessions }) => [name, sessions.length]), [
    ["sample-app", 2],
    ["docs-site", 0],
  ]);
  assert.deepEqual(state.workspaces[0].sessions.map(({ id }) => id), [first.id, second.id]);
});

test("shares one correlated approval across clients and rejects stale decisions", async (t) => {
  const { host, approvalServer } = fixture(t);
  await host.start();
  await host.dispatch("workspace/register", { path: "/workspace/sample-app" });
  const session = await host.dispatch("session/create", { workspacePath: "/workspace/sample-app", prompt: "first" });
  const payload = {
    session_id: session.threadId,
    turn_id: "turn-1",
    tool_use_id: "item-1",
    cwd: "/workspace/sample-app",
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command: "git push origin main" },
  };
  const approval = new Promise((resolve) => host.once("approval", resolve));
  approvalServer.emit("request", { requestId: "approval-1", payload, risk: { reason: "push" }, pendingCount: 1 });
  assert.equal((await approval).requestId, "approval-1");

  assert.deepEqual(await host.dispatch("approval/resolve", { requestId: "approval-1", decision: "approve" }), {
    requestId: "approval-1",
    decision: "approve",
  });
  assert.deepEqual(host.handleServerRequest({
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: session.threadId,
      turnId: "turn-1",
      itemId: "item-1",
      kind: "command",
      command: "git push origin main",
      cwd: "/workspace/sample-app",
    },
  }), { decision: "accept" });
  await assert.rejects(
    host.dispatch("approval/resolve", { requestId: "approval-1", decision: "approve" }),
    { code: "APPROVAL_NOT_CURRENT" },
  );
});

test("reorders one workspace and stops one session without affecting the other", async (t) => {
  const { host } = fixture(t);
  await host.start();
  await host.dispatch("workspace/register", { path: "/workspace/sample-app" });
  const first = await host.dispatch("session/create", { workspacePath: "/workspace/sample-app", prompt: "first" });
  const second = await host.dispatch("session/create", { workspacePath: "/workspace/sample-app", prompt: "second" });

  await host.dispatch("session/reorder", {
    workspacePath: "/workspace/sample-app",
    sessionId: second.id,
    direction: "up",
  });
  assert.deepEqual(host.snapshot().workspaces[0].sessions.map(({ id }) => id), [second.id, first.id]);
  await host.dispatch("session/stop", { workspacePath: "/workspace/sample-app", threadId: first.threadId });
  assert.deepEqual(host.snapshot().workspaces[0].sessions.map(({ id }) => id), [second.id]);
  assert.deepEqual(await host.dispatch("workspace/stopAll", { path: "/workspace/sample-app" }), {
    stopped: [second.threadId],
  });
  assert.deepEqual(host.snapshot().workspaces[0].sessions, []);
});

test("persists an explicit completed state and clears it when work resumes", async (t) => {
  const { host, services } = fixture(t);
  await host.start();
  const workspacePath = "/workspace/sample-app";
  await host.dispatch("workspace/register", { path: workspacePath });
  const session = await host.dispatch("session/create", { workspacePath, prompt: "first" });
  services.get(workspacePath).sessions[0].status = "Awaiting input";
  const refreshed = new Promise((resolve) => host.once("state", resolve));
  services.get(workspacePath).emit("changed");
  await refreshed;
  await host.dispatch("session/setCompleted", {
    workspacePath,
    sessionId: session.id,
    completed: true,
  });
  assert.equal(host.snapshot().workspaces[0].sessions[0].status, "Completed");
  assert.equal(host.snapshot().workspaces[0].sessions[0].routable, false);

  services.get(workspacePath).sendMessage = async () => ({ started: true });
  let published = 0;
  host.on("state", () => { published += 1; });
  await host.dispatch("session/send", {
    workspacePath,
    threadId: session.threadId,
    text: "continue",
  });
  assert.equal(published, 1);
  assert.equal(host.snapshot().workspaces[0].sessions[0].status, "Awaiting input");
});

test("refuses to mark a working session completed", async (t) => {
  const { host } = fixture(t);
  await host.start();
  const workspacePath = "/workspace/sample-app";
  await host.dispatch("workspace/register", { path: workspacePath });
  const session = await host.dispatch("session/create", { workspacePath, prompt: "first" });
  await assert.rejects(host.dispatch("session/setCompleted", {
    workspacePath,
    sessionId: session.id,
    completed: true,
  }), { code: "SESSION_NOT_IDLE" });
});

test("interrupts one turn without removing its session", async (t) => {
  const { host } = fixture(t);
  await host.start();
  const workspacePath = "/workspace/sample-app";
  await host.dispatch("workspace/register", { path: workspacePath });
  const session = await host.dispatch("session/create", { workspacePath, prompt: "first" });

  assert.deepEqual(await host.dispatch("session/interrupt", {
    workspacePath,
    threadId: session.threadId,
  }), { interrupted: true, threadId: session.threadId });
  assert.equal(host.snapshot().workspaces[0].sessions.length, 1);
  assert.equal(host.snapshot().workspaces[0].sessions[0].status, "Awaiting input");
});

test("publishes unchanged session summaries when a transcript event arrives", async (t) => {
  const { host, services } = fixture(t);
  await host.start();
  const workspacePath = "/workspace/sample-app";
  await host.dispatch("workspace/register", { path: workspacePath });
  await host.dispatch("session/create", { workspacePath, prompt: "first" });
  const state = new Promise((resolve) => host.once("state", resolve));

  services.get(workspacePath).emit("changed", { method: "item/completed" });

  assert.equal((await state).workspaces[0].sessions.length, 1);
});
