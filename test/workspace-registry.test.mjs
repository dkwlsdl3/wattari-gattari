import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkspaceRegistry } from "../src/workspace-registry.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-workspace-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  return new WorkspaceRegistry(path.join(directory, "workspaces.json"));
}

test("persists an empty workspace and increments its shared revision", (t) => {
  const registry = fixture(t);
  const changes = [];
  registry.on("changed", (change) => changes.push(change));

  registry.register("/home/demo/work/sample-app");
  registry.register("/home/demo/work/docs-site");

  assert.deepEqual(registry.snapshot(), {
    version: 1,
    revision: 2,
    workspaces: [
      { path: "/home/demo/work/sample-app", name: "sample-app", sessionOrder: [], completedSessions: [] },
      { path: "/home/demo/work/docs-site", name: "docs-site", sessionOrder: [], completedSessions: [] },
    ],
  });
  assert.deepEqual(changes.map(({ type }) => type), ["workspace/registered", "workspace/registered"]);
  assert.equal(fs.statSync(registry.filePath).mode & 0o777, 0o600);
});

test("persists session ordering and removes only empty workspaces", (t) => {
  const registry = fixture(t);
  const workspace = "/home/demo/work/sample-app";
  registry.recordSession(workspace, "codex:first");
  registry.recordSession(workspace, "codex:second");
  assert.equal(registry.moveSession(workspace, "codex:second", "up"), true);
  assert.deepEqual(registry.snapshot().workspaces[0].sessionOrder, ["codex:second", "codex:first"]);
  assert.equal(registry.setSessionCompleted(workspace, "codex:second", true), true);
  assert.deepEqual(registry.snapshot().workspaces[0].completedSessions, ["codex:second"]);
  assert.equal(registry.setSessionCompleted(workspace, "codex:second", true), false);
  assert.throws(() => registry.unregister(workspace), { code: "WORKSPACE_NOT_EMPTY" });
  registry.removeSession(workspace, "codex:second");
  assert.deepEqual(registry.snapshot().workspaces[0].completedSessions, []);
  registry.removeSession(workspace, "codex:first");
  assert.equal(registry.unregister(workspace), true);
  assert.deepEqual(registry.snapshot().workspaces, []);
});

test("loads version 1 registries written before completed session markers", (t) => {
  const registry = fixture(t);
  fs.mkdirSync(path.dirname(registry.filePath), { recursive: true });
  fs.writeFileSync(registry.filePath, JSON.stringify({
    version: 1,
    revision: 1,
    workspaces: [{ path: "/workspace", name: "workspace", sessionOrder: ["codex:first"] }],
  }));
  assert.deepEqual(registry.snapshot().workspaces[0].completedSessions, []);
});

test("fails closed on a malformed workspace registry", (t) => {
  const registry = fixture(t);
  fs.mkdirSync(path.dirname(registry.filePath), { recursive: true });
  fs.writeFileSync(registry.filePath, "{broken", { mode: 0o600 });
  assert.throws(() => registry.snapshot(), { code: "WORKSPACE_REGISTRY_INVALID" });
});
