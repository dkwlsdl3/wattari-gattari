import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { requestDirectApproval } from "../src/approval-gate.mjs";
import { ApprovalServer } from "../src/approval-server.mjs";

const RISKY_PAYLOAD = {
  session_id: "11111111-1111-7111-8111-111111111111",
  turn_id: "22222222-2222-7222-8222-222222222222",
  cwd: "/workspace",
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "git push origin main" },
};

function testSocket(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-approval-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  return path.join(directory, "approval.sock");
}

test("returns only the foreground screen decision over a user-only socket", async (t) => {
  const socketPath = testSocket(t);
  const server = new ApprovalServer(socketPath);
  await server.start();
  t.after(() => server.close());
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);

  const seen = new Promise((resolve) => server.once("request", resolve));
  const response = requestDirectApproval(socketPath, RISKY_PAYLOAD, { timeoutMs: 1_000 });
  const request = await seen;
  assert.equal(request.risk.reason, "Git 원격 반영 또는 작업트리 정리");
  assert.equal(server.resolve(request.requestId, "approve"), true);
  assert.equal((await response).decision, "approve");
});

test("queues concurrent approvals and resolves only the visible request", async (t) => {
  const socketPath = testSocket(t);
  const server = new ApprovalServer(socketPath);
  await server.start();
  t.after(() => server.close());

  const requests = [];
  server.on("request", (request) => requests.push(request));
  const firstResponse = requestDirectApproval(socketPath, RISKY_PAYLOAD, { timeoutMs: 1_000 });
  while (requests.length < 1) await new Promise((resolve) => setImmediate(resolve));
  const secondResponse = requestDirectApproval(socketPath, {
    ...RISKY_PAYLOAD,
    tool_use_id: "33333333-3333-7333-8333-333333333333",
    tool_input: { command: "rm -- second.txt" },
  }, { timeoutMs: 1_000 });
  while (server.pendingCount < 2) await new Promise((resolve) => setImmediate(resolve));

  assert.equal(requests.length, 1);
  assert.equal(server.resolve(requests[0].requestId, "approve"), true);
  while (requests.length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.resolve(requests[0].requestId, "deny"), false);
  assert.equal(server.resolve(requests[1].requestId, "deny"), true);
  assert.equal((await firstResponse).decision, "approve");
  assert.equal((await secondResponse).decision, "deny");
});

test("fails closed when no foreground approval screen is listening", async (t) => {
  const response = await requestDirectApproval(testSocket(t), RISKY_PAYLOAD, { timeoutMs: 100 });
  assert.equal(response.decision, "deny");
});

test("rejects payloads that the server cannot independently classify", async (t) => {
  const socketPath = testSocket(t);
  const server = new ApprovalServer(socketPath);
  await server.start();
  t.after(() => server.close());

  const response = await requestDirectApproval(socketPath, {
    ...RISKY_PAYLOAD,
    tool_input: { command: "npm test" },
  }, { timeoutMs: 1_000 });
  assert.equal(response.decision, "deny");
  assert.match(response.reason, /검증할 수 없는/);
});

test("closes cleanly even when a client connects without sending a request", async (t) => {
  const socketPath = testSocket(t);
  const server = new ApprovalServer(socketPath);
  await server.start();
  const idleClient = net.connect(socketPath);
  await new Promise((resolve, reject) => {
    idleClient.once("connect", resolve);
    idleClient.once("error", reject);
  });
  await server.close();
  assert.equal(fs.existsSync(socketPath), false);
});
