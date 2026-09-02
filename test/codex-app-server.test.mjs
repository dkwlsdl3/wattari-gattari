import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";

import { CodexAppServerClient } from "../src/codex-app-server.mjs";

class FakeSocket extends EventEmitter {
  readyState = WebSocket.OPEN;
  sent = [];
  send(text) {
    const message = JSON.parse(text);
    this.sent.push(message);
    if (message.method === "initialize") queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify({ id: message.id, result: { userAgent: "fake" } })), false));
  }
  close() { this.readyState = WebSocket.CLOSED; queueMicrotask(() => this.emit("close")); }
  terminate() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
}

test("Codex App Server client initializes and declines native approvals", async () => {
  const socket = new FakeSocket();
  const client = new CodexAppServerClient(socket);
  assert.equal((await client.initialize()).userAgent, "fake");
  socket.emit("message", Buffer.from(JSON.stringify({ id: 99, method: "item/commandExecution/requestApproval", params: {} })), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(socket.sent.find((message) => message.id === 99), { id: 99, result: { decision: "decline" } });
  await client.close();
});
