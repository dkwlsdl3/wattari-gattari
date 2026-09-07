import assert from "node:assert/strict";
import { EventEmitter, getEventListeners } from "node:events";
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

test("RPC timeout releases the request and listener without replaying a submission", async (t) => {
  const socket = new FakeSocket();
  const client = new CodexAppServerClient(socket);
  t.after(() => client.close());
  const controller = new AbortController();
  await assert.rejects(client.request("turn/start", {}, { signal: controller.signal, timeoutMs: 10 }), { code: "CODEX_RPC_TIMEOUT" });
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(socket.sent.length, 1);
  const answer = client.request("read", {}, { timeoutMs: 100 });
  socket.emit("message", Buffer.from(JSON.stringify({ id: socket.sent[0].id, result: "late" })), false);
  socket.emit("message", Buffer.from(JSON.stringify({ id: socket.sent[1].id, result: "current" })), false);
  assert.equal(await answer, "current");
});

test("RPC asynchronous write failure rejects its pending request", async (t) => {
  const socket = new FakeSocket();
  const failure = new Error("async write failed");
  socket.send = (_text, callback) => queueMicrotask(() => callback?.(failure));
  const client = new CodexAppServerClient(socket);
  t.after(() => client.close());
  await assert.rejects(client.request("read", {}, { timeoutMs: 100 }), (error) => error === failure);
});

test("Codex App Server client initializes and declines native approvals", async () => {
  const socket = new FakeSocket();
  const client = new CodexAppServerClient(socket);
  assert.equal((await client.initialize()).userAgent, "fake");
  socket.emit("message", Buffer.from(JSON.stringify({ id: 99, method: "item/commandExecution/requestApproval", params: {} })), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(socket.sent.find((message) => message.id === 99), { id: 99, result: { decision: "decline" } });
  await client.close();
});

test("RPC ignores non-object JSON frames without losing the pending response", async (t) => {
  const socket = new FakeSocket();
  const client = new CodexAppServerClient(socket);
  t.after(() => client.close());
  const answer = client.request("read", {});
  void answer.catch(() => {});
  for (const frame of ["null", "42", '"text"', "[]", "{bad json"]) {
    assert.doesNotThrow(() => socket.emit("message", Buffer.from(frame), false));
  }
  socket.emit("message", Buffer.from(JSON.stringify({ id: socket.sent[0].id, result: "right" })), false);
  assert.equal(await answer, "right");
});

test("failed RPC send removes its abort listener immediately", async (t) => {
  const socket = new FakeSocket();
  const failure = new Error("send failed");
  socket.send = () => { throw failure; };
  const client = new CodexAppServerClient(socket);
  t.after(() => client.close());
  const controller = new AbortController();
  const remove = t.mock.method(controller.signal, "removeEventListener");
  await assert.rejects(client.request("read", {}, { signal: controller.signal }), (error) => error === failure);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  socket.emit("error", new Error("late socket error"));
  assert.equal(remove.mock.callCount(), 1, "failed send must not leave a pending request behind");
});

test("server-request completion after close does not send or reject in the background", async () => {
  const socket = new FakeSocket();
  let finish;
  const client = new CodexAppServerClient(socket, {
    onServerRequest: () => new Promise((resolve) => { finish = resolve; }),
  });
  socket.emit("message", Buffer.from(JSON.stringify({ id: 99, method: "custom", params: {} })), false);
  assert.equal(typeof finish, "function");
  await client.close();
  finish({ done: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(socket.sent, []);
});

test("RPC matches out-of-order responses, ignores duplicates and cleans cancellation listeners", async (t) => {
  const socket = new FakeSocket();
  const client = new CodexAppServerClient(socket);
  t.after(() => client.close());
  const first = new AbortController();
  const second = new AbortController();
  const removeFirst = t.mock.method(first.signal, "removeEventListener");
  const removeSecond = t.mock.method(second.signal, "removeEventListener");
  const one = client.request("one", { value: 1 }, { signal: first.signal });
  const two = client.request("two", { value: 2 }, { signal: second.signal });
  const [a, b] = socket.sent;
  assert.notEqual(a.id, b.id);
  assert.deepEqual(a, { method: "one", id: a.id, params: { value: 1 } });
  const respond = (message) => socket.emit("message", Buffer.from(JSON.stringify(message)), false);
  respond({ id: -1, result: "unknown" });
  respond({ id: b.id, result: "second" });
  respond({ id: b.id, error: { code: 1, message: "duplicate" } });
  const rejected = assert.rejects(one, { code: "CODEX_APP_SERVER_ERROR", message: "17: first failed" });
  respond({ id: a.id, error: { code: 17, message: "first failed" } });
  await rejected;
  assert.equal(await two, "second");
  assert.equal(getEventListeners(first.signal, "abort").length, 0);
  assert.equal(getEventListeners(second.signal, "abort").length, 0);
  socket.emit("error", new Error("late error"));
  assert.equal(removeFirst.mock.callCount(), 1);
  assert.equal(removeSecond.mock.callCount(), 1);
});

test("RPC abort and remote close reject only the appropriate pending requests", async (t) => {
  const socket = new FakeSocket();
  const client = new CodexAppServerClient(socket);
  t.after(() => client.close());
  const cancelled = new AbortController();
  const pending = new AbortController();
  const reason = new Error("cancelled by caller");
  cancelled.abort(reason);
  await assert.rejects(client.request("never sent", {}, { signal: cancelled.signal }), (error) => error === reason);
  assert.deepEqual(socket.sent, []);
  const active = new AbortController();
  const removeActive = t.mock.method(active.signal, "removeEventListener");
  const removePending = t.mock.method(pending.signal, "removeEventListener");
  const aborted = assert.rejects(client.request("abort", {}, { signal: active.signal }), (error) => error === reason);
  const closed = assert.rejects(client.request("pending", {}, { signal: pending.signal }), { code: "CODEX_APP_SERVER_CLOSED" });
  active.abort(reason);
  await aborted;
  assert.equal(getEventListeners(active.signal, "abort").length, 0);
  assert.equal(getEventListeners(pending.signal, "abort").length, 1);
  socket.readyState = WebSocket.CLOSED;
  socket.emit("close");
  await closed;
  assert.equal(getEventListeners(pending.signal, "abort").length, 0);
  socket.emit("error", new Error("late close error"));
  assert.equal(removeActive.mock.callCount(), 0, "abort must remove its request from the pending map");
  assert.equal(removePending.mock.callCount(), 1, "disconnect must clear the pending map");
});

test("RPC routes notifications and server-request results or errors without replying twice", async (t) => {
  const socket = new FakeSocket();
  const notifications = [];
  const requests = [];
  const client = new CodexAppServerClient(socket, {
    onNotification: (message) => notifications.push(message),
    onServerRequest: (message) => {
      requests.push(message);
      if (message.method === "fail") throw new Error("handler failed");
      if (message.method === "custom") return { accepted: false };
      return undefined;
    },
  });
  t.after(() => client.close());
  for (const message of [
    { method: "notice", params: { changed: true } },
    { id: 0, method: "custom", params: { value: 2 } },
    { id: 1, method: "fail", params: {} },
    { id: 2, method: "unknown", params: {} },
    {},
  ]) socket.emit("message", Buffer.from(JSON.stringify(message)), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(notifications, [{ method: "notice", params: { changed: true } }]);
  assert.deepEqual(requests, [
    { method: "custom", params: { value: 2 } },
    { method: "fail", params: {} },
    { method: "unknown", params: {} },
  ]);
  assert.deepEqual(socket.sent.toSorted((left, right) => left.id - right.id), [
    { id: 0, result: { accepted: false } },
    { id: 1, error: { code: -32603, message: "handler failed" } },
    { id: 2, error: { code: -32603, message: "Waga does not handle server request unknown" } },
  ]);
});

test("failed server-response send rejects pending RPCs and does not retry the broken socket", async (t) => {
  const socket = new FakeSocket();
  const client = new CodexAppServerClient(socket);
  t.after(() => client.close());
  const controller = new AbortController();
  const failure = new Error("response send failed");
  const pending = assert.rejects(client.request("read", {}, { signal: controller.signal }), (error) => error === failure);
  let attempts = 0;
  socket.send = () => { attempts += 1; throw failure; };
  socket.emit("message", Buffer.from(JSON.stringify({ id: 99, method: "item/fileChange/requestApproval" })), false);
  await pending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(attempts, 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("RPC notification and error paths do not require optional callbacks or an abort signal", async (t) => {
  const socket = new FakeSocket();
  const client = new CodexAppServerClient(socket);
  t.after(() => client.close());
  assert.doesNotThrow(() => socket.emit("message", Buffer.from('{"method":"notice"}'), false));
  const pending = assert.rejects(client.request("read", {}), { code: "CODEX_WS_BINARY_MESSAGE" });
  socket.emit("message", Buffer.from([0]), true);
  await pending;
});
