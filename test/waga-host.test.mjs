import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WagaHost } from "../src/waga-host.mjs";
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
  addSession(name = "Codex 작업") {
    const threadId = `${this.workspacePath}-${this.nextId++}`;
    const session = {
      id: `codex:${threadId}`,
      threadId,
      provider: "codex",
      name,
      cwd: this.workspacePath,
      status: "Awaiting input",
      lastActivity: "아직 대화가 없습니다",
      updatedAt: this.nextId,
    };
    this.sessions.push(session);
    return structuredClone(session);
  }
  async renameSession(threadId, name) {
    this.sessions.find((session) => session.threadId === threadId).name = name;
  }
  async stopSession(threadId) {
    this.sessions = this.sessions.filter((session) => session.threadId !== threadId);
  }
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-host-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const services = new Map();
  const host = new WagaHost({
    registry: new WorkspaceRegistry(path.join(directory, "workspaces.json")),
    sessionFactory: (workspacePath) => {
      const service = new FakeSessionService(workspacePath);
      services.set(workspacePath, service);
      return service;
    },
  });
  t.after(() => host.close());
  return { host, services };
}

test("aggregates native sessions from registered workspaces", async (t) => {
  const { host, services } = fixture(t);
  await host.start();
  await host.dispatch("workspace/register", { path: "/workspace/sample-app" });
  await host.dispatch("workspace/register", { path: "/workspace/docs-site" });
  const first = services.get("/workspace/sample-app").addSession();
  services.get("/workspace/sample-app").emit("changed", { method: "thread/started" });
  await new Promise((resolve) => host.once("state", resolve));
  assert.deepEqual(host.snapshot().workspaces.map(({ name, sessions }) => [name, sessions.length]), [
    ["sample-app", 1],
    ["docs-site", 0],
  ]);
  assert.deepEqual(host.snapshot().workspaces[0].sessions.map(({ id }) => id), [first.id]);
  assert.equal("approval" in host.snapshot(), false);
});

test("exposes only control-plane methods, not conversation or approval emulation", async (t) => {
  const { host } = fixture(t);
  await host.start();
  for (const method of [
    "session/open",
    "session/read",
    "session/older",
    "session/send",
    "session/command",
    "session/interrupt",
    "session/create",
    "approval/resolve",
  ]) {
    await assert.rejects(host.dispatch(method, {}), { code: "METHOD_NOT_FOUND" });
  }
});

test("renames, reorders, completes, and stops sessions as metadata operations", async (t) => {
  const { host, services } = fixture(t);
  const workspacePath = "/workspace/sample-app";
  await host.start();
  await host.dispatch("workspace/register", { path: workspacePath });
  const first = services.get(workspacePath).addSession("first");
  const second = services.get(workspacePath).addSession("second");
  services.get(workspacePath).emit("changed", { method: "thread/started" });
  await new Promise((resolve) => host.once("state", resolve));

  await host.dispatch("session/rename", { workspacePath, threadId: first.threadId, name: "renamed" });
  assert.equal(host.snapshot().workspaces[0].sessions[0].name, "renamed");
  await host.dispatch("session/reorder", { workspacePath, sessionId: second.id, direction: "up" });
  assert.deepEqual(host.snapshot().workspaces[0].sessions.map(({ id }) => id), [second.id, first.id]);
  await host.dispatch("session/setCompleted", { workspacePath, sessionId: second.id, completed: true });
  assert.equal(host.snapshot().workspaces[0].sessions[0].status, "Completed");
  await host.dispatch("session/stop", { workspacePath, threadId: first.threadId });
  assert.deepEqual(host.snapshot().workspaces[0].sessions.map(({ id }) => id), [second.id]);
  assert.equal(services.get(workspacePath).sessions.length, 1);
});

test("refuses to mark a working session completed and refreshes native status events", async (t) => {
  const { host, services } = fixture(t);
  const workspacePath = "/workspace/sample-app";
  await host.start();
  await host.dispatch("workspace/register", { path: workspacePath });
  const session = services.get(workspacePath).addSession();
  services.get(workspacePath).sessions[0].status = "Working";
  const refreshed = new Promise((resolve) => host.once("state", resolve));
  services.get(workspacePath).emit("changed", { method: "turn/started" });
  await refreshed;
  await assert.rejects(host.dispatch("session/setCompleted", {
    workspacePath,
    sessionId: session.id,
    completed: true,
  }), { code: "SESSION_NOT_IDLE" });
});
