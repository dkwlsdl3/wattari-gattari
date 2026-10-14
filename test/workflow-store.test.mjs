import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkflowStore } from "../src/workflow-store.mjs";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-flow-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = new WorkflowStore(path.join(directory, "flows"));
  let row = store.create({ title: "Keeper #263", cwd: directory });
  return { store, directory, get row() { return store.read(row.id); }, update(input) { row = store.update(row.id, { revision: this.row.revision, ...input }); return row; } };
}

test("workflow progress requires prerequisite evidence and survives restart without inferring native state", t => {
  const f = fixture(t);
  assert.throws(() => f.update({ action: "state", nodeId: "verify", state: "passed", evidence: "ok" }), { status: 409 });
  assert.throws(() => f.update({ action: "state", nodeId: "plan", state: "passed" }), { status: 400 });
  f.update({ action: "state", nodeId: "plan", state: "passed", evidence: "요구사항 확인" });
  f.update({ action: "state", nodeId: "implement", state: "passed", evidence: "구현 diff" });
  assert.throws(() => f.update({ action: "state", nodeId: "verify", state: "passed", evidence: "tests passed" }), { status: 400 });
  f.update({ action: "commit", commit: "a".repeat(40) });
  f.update({ action: "state", nodeId: "verify", state: "passed", evidence: "CI https://ci.example/42" });
  const restarted = new WorkflowStore(f.store.directory);
  const read = restarted.read(f.row.id);
  assert.equal(read.nodes.find(row => row.id === "verify").evidenceCommit, "a".repeat(40));
  assert.equal(read.nodes.find(row => row.id === "review").state, "pending");
  assert.equal(restarted.list("/unrelated").length, 0);
  assert.equal(restarted.list(f.directory)[0].id, read.id);
  assert.equal(fs.statSync(path.join(f.store.directory, `${read.id}.json`)).mode & 0o777, 0o600);
});

test("changed commit and upstream rework invalidate dependent proofs and retain the return reason", t => {
  const f = fixture(t);
  f.update({ action: "commit", commit: "a".repeat(40) });
  for (const node of f.row.nodes) f.update({ action: "state", nodeId: node.id, state: "passed", evidence: "observed proof" });
  f.update({ action: "commit", commit: "b".repeat(40) });
  assert.equal(f.row.nodes[1].state, "passed");
  assert.ok(f.row.nodes.slice(2).every(row => row.state === "pending" && !row.evidence && !row.evidenceCommit));
  f.update({ action: "state", nodeId: "verify", state: "blocked", note: "API regression" });
  f.update({ action: "rework", nodeId: "verify", targetId: "implement", note: "API regression" });
  assert.equal(f.row.nodes[1].state, "active");
  assert.ok(f.row.nodes.slice(2).every(row => row.state === "pending"));
  assert.equal(f.row.returns.at(-1).reason, "API regression");
  assert.throws(() => f.update({ action: "rework", nodeId: "plan", targetId: "review", note: "forward" }), { status: 400 });
  assert.throws(() => f.update({ action: "state", nodeId: "plan", state: "blocked" }), { status: 400 });
});

test("transport completion never passes a stage and stale editors cannot overwrite attached answers", t => {
  const f = fixture(t), original = f.row;
  f.store.attach(original.id, "plan", { operationId: "op", requestId: "req", state: "accepted" });
  assert.throws(() => f.store.update(original.id, { revision: original.revision, action: "assign", nodeId: "plan", sessionId: "codex:one" }), { status: 409 });
  f.store.attach(original.id, "plan", { operationId: "op", requestId: "req", state: "replied", reply: "tests passed " + "x".repeat(4500) });
  const node = f.row.nodes[0];
  assert.equal(node.state, "pending"); assert.equal(node.requests.length, 1); assert.equal(node.requests[0].requestId, "req");
  assert.equal(node.requests[0].replyLimited, true); assert.equal(node.requests[0].reply.length, 4000);
  assert.throws(() => f.update({ action: "assign", nodeId: "plan", sessionId: "invalid" }), { status: 400 });
  assert.throws(() => f.store.read("../outside"), { status: 400 });
});

test("independent review cannot pass with the implementer's session", t => {
  const f = fixture(t);
  f.update({ action: "commit", commit: "a".repeat(40) });
  for (const nodeId of ["implement", "review"]) f.update({ action: "assign", nodeId, sessionId: "codex:same" });
  for (const nodeId of ["plan", "implement", "verify"]) f.update({ action: "state", nodeId, state: "passed", evidence: "proof" });
  assert.throws(() => f.update({ action: "state", nodeId: "review", state: "passed", evidence: "self review" }), { status: 409 });
  f.update({ action: "assign", nodeId: "review", sessionId: "claude:independent" });
  f.update({ action: "state", nodeId: "review", state: "passed", evidence: "reviewer accepted" });
  assert.equal(f.row.nodes[3].state, "passed");
});


test("reassigning a completed implementer invalidates dependent evidence", t => {
  const f = fixture(t);
  f.update({ action: "commit", commit: "a".repeat(40) });
  f.update({ action: "assign", nodeId: "implement", sessionId: "codex:first" });
  for (const step of f.row.nodes) f.update({ action: "state", nodeId: step.id, state: "passed", evidence: "proof" });
  f.update({ action: "assign", nodeId: "implement", sessionId: "codex:second" });
  assert.ok(f.row.nodes.slice(1).every(row => row.state === "pending" && !row.evidence));
});
