import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildClaudeFrame, ClaudePeerEndpoint, parseClaudeFrame } from "../src/providers/claude-peer.mjs";
import { ClaudeProvider } from "../src/providers/claude.mjs";

function listen(server, socketPath) {
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
}

test("Claude peer endpoint sends measured NDJSON shape and receives one reply", { timeout: 2_000 }, async (t) => {
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
  const endpoint = new ClaudePeerEndpoint({ homeDirectory: home, cwd: root });
  t.after(async () => { await endpoint.stop(); await new Promise((resolve) => target.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  await listen(target, targetPath);
  await endpoint.start({ socketDirectory: sockets });
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

test("Claude peer endpoint rejects a shared socket directory", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-peer-shared-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.chmodSync(root, 0o777);
  const endpoint = new ClaudePeerEndpoint({ homeDirectory: path.join(root, "home") });
  await assert.rejects(endpoint.start({ socketDirectory: root }), { code: "CLAUDE_SOCKET_DIR_PERMISSIONS" });
});

test("Claude peer endpoint does not miss a hold status that arrives before waiting", { timeout: 2_000 }, async (t) => {
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
  const endpoint = new ClaudePeerEndpoint({ homeDirectory: home, cwd: root });
  t.after(async () => {
    await endpoint.stop();
    await new Promise((resolve) => target.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await listen(target, targetPath);
  await endpoint.start({ socketDirectory: sockets });
  const id = await endpoint.send(targetPath, "hello");
  await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(endpoint.waitForDisposition(id, { timeoutMs: 1_000 }), { code: "MESSAGE_HELD" });
  await assert.rejects(endpoint.waitForReply(targetPath, id, { timeoutMs: 1_000 }), { code: "MESSAGE_HELD" });
});

test("provider cleanup after peer identity collision preserves the existing socket and registry", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-peer-collision-"));
  const home = path.join(root, "home");
  const sockets = path.join(root, "sockets");
  const registryDirectory = path.join(home, ".claude", "sessions");
  fs.mkdirSync(sockets, { mode: 0o700 });
  fs.mkdirSync(registryDirectory, { recursive: true });
  const socketPath = path.join(sockets, `${process.pid}.sock`);
  const registryPath = path.join(registryDirectory, `${process.pid}.json`);
  const original = '{"identity":"existing-proof-session"}';
  fs.writeFileSync(registryPath, original);
  const server = net.createServer((socket) => socket.end());
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  await listen(server, socketPath);
  const provider = new ClaudeProvider({ homeDirectory: home });
  await assert.rejects(provider.send({ socketPath }, "do not send", { requestId: "proof" }), { code: "CLAUDE_PEER_COLLISION" });
  assert.equal(fs.existsSync(socketPath), true, "existing socket must survive failed start + finally stop");
  assert.equal(fs.readFileSync(registryPath, "utf8"), original);
});

test("peer stop removes its own identity, keeps unrelated files and supports restart", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-peer-cleanup-"));
  const home = path.join(root, "home");
  const sockets = path.join(root, "sockets");
  fs.mkdirSync(sockets, { mode: 0o700 });
  const endpoint = new ClaudePeerEndpoint({ homeDirectory: home, cwd: root });
  t.after(async () => { await endpoint.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const unrelated = path.join(sockets, "unrelated");
  fs.writeFileSync(unrelated, "keep");
  const exits = process.listenerCount("exit");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await endpoint.start({ socketDirectory: sockets });
    const socketPath = endpoint.socketPath;
    const sessions = path.join(home, ".claude", "sessions");
    const files = fs.readdirSync(sessions);
    assert.equal(files.length, 2);
    assert.ok(files.includes(`${process.pid}.json`));
    assert.ok(files.some((file) => file.endsWith(".key")));
    for (const file of files) assert.equal(fs.statSync(path.join(sessions, file)).mode & 0o777, 0o600);
    const registry = path.join(sessions, `${process.pid}.json`);
    assert.equal(JSON.parse(fs.readFileSync(registry, "utf8")).messagingSocketPath, socketPath);
    const key = JSON.parse(fs.readFileSync(path.join(sessions, files.find((file) => file.endsWith(".key"))), "utf8"));
    assert.match(key.peerToken, /^[a-f0-9]{32}$/);
    assert.equal(process.listenerCount("exit"), exits + 1);
    await endpoint.stop();
    await endpoint.stop();
    assert.equal(endpoint.socketPath, null);
    assert.equal(fs.existsSync(socketPath), false);
    assert.deepEqual(fs.readdirSync(sessions), []);
    assert.equal(fs.readFileSync(unrelated, "utf8"), "keep");
    assert.equal(process.listenerCount("exit"), exits);
    fs.writeFileSync(registry, "new owner after stop");
    await endpoint.stop();
    assert.equal(fs.readFileSync(registry, "utf8"), "new owner after stop");
    fs.unlinkSync(registry);
  }
});

test("peer rejects a dangling registry symlink without deleting or following it", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-peer-symlink-"));
  const sessions = path.join(root, ".claude", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const registry = path.join(sessions, `${process.pid}.json`);
  const missing = path.join(root, "must-not-create");
  fs.symlinkSync(missing, registry);
  const endpoint = new ClaudePeerEndpoint({ homeDirectory: root });
  t.after(async () => { await endpoint.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await assert.rejects(endpoint.start({ socketDirectory: root }), { code: "CLAUDE_PEER_COLLISION" });
  await endpoint.stop();
  assert.equal(fs.readlinkSync(registry), missing);
  assert.equal(fs.existsSync(missing), false);
});

test("registry creation race preserves the competing file and removes only the new socket", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-peer-race-"));
  const registry = path.join(root, ".claude", "sessions", `${process.pid}.json`);
  const endpoint = new ClaudePeerEndpoint({ homeDirectory: root });
  t.after(async () => { await endpoint.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const open = fs.openSync;
  t.mock.method(fs, "openSync", (file, flags, mode) => {
    if (file === registry) {
      const descriptor = open(file, "wx", 0o600);
      try { fs.writeFileSync(descriptor, "competing identity"); }
      finally { fs.closeSync(descriptor); }
    }
    return open(file, flags, mode);
  });
  await assert.rejects(endpoint.start({ socketDirectory: root }), { code: "EEXIST" });
  await endpoint.stop();
  assert.equal(fs.readFileSync(registry, "utf8"), "competing identity");
  assert.equal(fs.existsSync(path.join(root, `${process.pid}.sock`)), false);
  assert.deepEqual(fs.readdirSync(path.dirname(registry)), [`${process.pid}.json`]);
});

test("failed identity write closes the descriptor and removes partially created files", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-peer-write-"));
  const endpoint = new ClaudePeerEndpoint({ homeDirectory: root });
  t.after(async () => { await endpoint.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const write = fs.writeFileSync;
  const failure = new Error("disk write failed");
  let descriptor;
  t.mock.method(fs, "writeFileSync", (file, ...args) => {
    if (typeof file === "number") {
      descriptor = file;
      write(file, "partial");
      throw failure;
    }
    return write(file, ...args);
  });
  await assert.rejects(endpoint.start({ socketDirectory: root }), (error) => error === failure);
  assert.equal(typeof descriptor, "number");
  assert.throws(() => fs.fstatSync(descriptor), { code: "EBADF" });
  assert.equal(endpoint.socketPath, null);
  assert.equal(fs.existsSync(path.join(root, `${process.pid}.sock`)), false);
  assert.deepEqual(fs.readdirSync(path.join(root, ".claude", "sessions")), []);
});
