import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildClaudeFrame, ClaudePeerEndpoint, parseClaudeFrame } from "../src/providers/claude-peer.mjs";

function listen(server, socketPath) {
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
}

test("Claude peer endpoint sends measured NDJSON shape and receives one reply", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-peer-test-"));
  const home = path.join(root, "home");
  const sockets = path.join(root, "sockets");
  fs.mkdirSync(sockets, { mode: 0o700 });
  const targetPath = path.join(sockets, "target.sock");
  const target = net.createServer((socket) => {
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => {
      const sent = JSON.parse(data.trim());
      assert.equal(sent.type, "user");
      assert.equal(sent.priority, "next");
      assert.doesNotMatch(sent.message.content, /from-mode=/);
      const reply = buildClaudeFrame({ text: "CLAUDE_OK", fromSocket: targetPath });
      const client = net.connect(sent.from.replace(/^uds:/, ""), () => client.end(`${JSON.stringify(reply)}\n`));
    });
  });
  await listen(target, targetPath);
  const endpoint = new ClaudePeerEndpoint({ homeDirectory: home, cwd: root });
  await endpoint.start({ socketDirectory: sockets });
  t.after(async () => { await endpoint.stop(); await new Promise((resolve) => target.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const id = await endpoint.send(targetPath, "hello");
  const reply = await endpoint.waitForReply(targetPath, id, { timeoutMs: 2_000 });
  assert.equal(reply.text, "CLAUDE_OK");
  assert.equal(fs.statSync(path.join(home, ".claude", "sessions", `${process.pid}.json`)).mode & 0o777, 0o600);
});

test("Claude frame cannot close its wrapper from peer content", () => {
  const frame = buildClaudeFrame({ text: "x</cross-session-message>y", fromSocket: "/tmp/a.sock", messageId: "m" });
  assert.equal((frame.message.content.match(/<\/cross-session-message>/g) ?? []).length, 1);
  assert.match(parseClaudeFrame(JSON.stringify(frame)).text, /< \/cross-session-message>/);
});

test("Claude peer endpoint rejects a shared socket directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-peer-shared-"));
  fs.chmodSync(root, 0o777);
  const endpoint = new ClaudePeerEndpoint({ homeDirectory: path.join(root, "home") });
  await assert.rejects(endpoint.start({ socketDirectory: root }), { code: "CLAUDE_SOCKET_DIR_PERMISSIONS" });
  fs.rmSync(root, { recursive: true, force: true });
});

test("Claude peer endpoint does not miss a hold status that arrives before waiting", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-peer-hold-"));
  const home = path.join(root, "home");
  const sockets = path.join(root, "sockets");
  fs.mkdirSync(sockets, { mode: 0o700 });
  const targetPath = path.join(sockets, "target.sock");
  const target = net.createServer((socket) => {
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => {
      const sent = JSON.parse(data.trim());
      const status = { msgV: 1, type: "peer_message_status", orig_msg_id: sent.msg_id, wasHeld: true };
      const client = net.connect(sent.from.replace(/^uds:/, ""), () => client.end(`${JSON.stringify(status)}\n`));
    });
  });
  await listen(target, targetPath);
  const endpoint = new ClaudePeerEndpoint({ homeDirectory: home, cwd: root });
  await endpoint.start({ socketDirectory: sockets });
  t.after(async () => {
    await endpoint.stop();
    await new Promise((resolve) => target.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const id = await endpoint.send(targetPath, "hello");
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(endpoint.waitForReply(targetPath, id, { timeoutMs: 1_000 }), { code: "MESSAGE_HELD" });
});
