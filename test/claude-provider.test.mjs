import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ClaudeProvider, parseClaudeAgents, parseClaudeBackgroundId } from "../src/providers/claude.mjs";

test("Claude agents parser rejects drifted output", () => {
  assert.throws(() => parseClaudeAgents("{}"), { code: "CLAUDE_AGENTS_INVALID" });
});

test("Claude background parser accepts the measured CLI output", () => {
  const stdout = [
    "backgrounded · 8d96d424 · waga-proof-create-cli",
    "  claude agents             list sessions",
    "  claude attach 8d96d424    open in this terminal",
    "",
  ].join("\n");
  assert.equal(parseClaudeBackgroundId(stdout), "8d96d424");
  assert.equal(parseClaudeBackgroundId("backgrounded · 646ce04f\n  claude agents  list sessions\n"), "646ce04f");
  assert.throws(() => parseClaudeBackgroundId("started maybe"), { code: "CLAUDE_BACKGROUND_INVALID" });
});

test("Claude create starts an official background agent in the requested workspace", async () => {
  let invocation;
  const provider = new ClaudeProvider({
    run: async (args, options) => {
      invocation = { args, options };
      return { stdout: "backgrounded · 1234abcd · task\n" };
    },
  });
  const result = await provider.create("review this change", { cwd: "/work/project" });
  assert.deepEqual(result, { provider: "claude", nativeId: "1234abcd" });
  assert.deepEqual(invocation, {
    args: ["--bg", "--", "review this change"],
    options: { cwd: "/work/project" },
  });
});

test("Claude archive removes only the Agents background job through the native CLI", async () => {
  let invocation;
  const provider = new ClaudeProvider({
    run: async (args, options) => {
      invocation = { args, options };
      return { stdout: "" };
    },
  });
  const result = await provider.archive({ id: "claude:full-id", nativeId: "1234abcd", projectCwd: "/work/project" });
  assert.deepEqual(result, { target: "claude:full-id", archived: true });
  assert.deepEqual(invocation, {
    args: ["rm", "1234abcd"],
    options: { cwd: "/work/project" },
  });
});

test("Claude rename stores a Waga display alias", async () => {
  const calls = [];
  const aliasCatalog = {
    load() { return new Map(); },
    set(id, name) { calls.push([id, name]); },
  };
  const provider = new ClaudeProvider({ aliasCatalog });
  const result = await provider.rename({ id: "claude:full-id" }, "  review UI  ");
  assert.deepEqual(result, { target: "claude:full-id", renamed: true, name: "review UI" });
  assert.deepEqual(calls, [["claude:full-id", "review UI"]]);
});

test("Claude provider joins agents JSON to the live peer registry", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-claude-provider-"));
  const sessions = path.join(root, ".claude", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const socketPath = path.join(root, "target.sock");
  const server = net.createServer();
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const row = { id: "1234abcd", sessionId: "full-id", cwd: process.cwd(), pid: process.pid, name: "target", status: "idle", startedAt: 7 };
  fs.writeFileSync(path.join(sessions, `${process.pid}.json`), JSON.stringify({ ...row, peerProtocol: 1, messagingSocketPath: socketPath }));
  const endpointCalls = [];
  const endpoint = { async start(value) { endpointCalls.push(["start", value]); }, async send(_socket, text) { endpointCalls.push(["send", text]); return "message-1"; }, async waitForReply() { return { text: "OK" }; }, async stop() { endpointCalls.push(["stop"]); } };
  const provider = new ClaudeProvider({
    homeDirectory: root,
    run: async () => ({ stdout: JSON.stringify([row]) }),
    endpointFactory: () => endpoint,
    aliasCatalog: { load: () => new Map([["claude:full-id", "renamed target"]]) },
  });
  const listed = await provider.list({ cwd: process.cwd() });
  assert.equal(listed[0].id, "claude:full-id");
  assert.equal(listed[0].name, "renamed target");
  assert.equal(listed[0].nativeId, "1234abcd");
  const answer = await provider.ask(listed[0], "hello", { requestId: "r", timeoutMs: 9 });
  assert.equal(answer.reply, "OK");
  assert.match(endpointCalls.find(([kind]) => kind === "send")[1], /trust: untrusted/);
});

test("Claude send checks immediate peer disposition before reporting submission", async () => {
  const calls = [];
  const endpoint = {
    async start() { calls.push("start"); },
    async send() { calls.push("send"); return "message-1"; },
    async waitForDisposition(id, options) { calls.push(`disposition:${id}:${options.timeoutMs}`); return { state: "submitted" }; },
    async stop() { calls.push("stop"); },
  };
  const provider = new ClaudeProvider({ endpointFactory: () => endpoint });
  const result = await provider.send({ id: "claude:x", socketPath: "/private/target.sock" }, "notice", { requestId: "r" });
  assert.equal(result.delivery, "submitted");
  assert.deepEqual(calls, ["start", "send", "disposition:message-1:150", "stop"]);
});

test("Claude provider mirrors the active Agents view and keeps its worktrees in the parent project", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-claude-project-"));
  const worktree = path.join(root, "project", ".claude", "worktrees", "issue-1");
  const sessions = path.join(root, ".claude", "sessions");
  fs.mkdirSync(worktree, { recursive: true });
  fs.mkdirSync(sessions, { recursive: true });
  const socketPath = path.join(root, "target.sock");
  const server = net.createServer();
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });

  const row = { id: "1234abcd", sessionId: "worktree-id", cwd: worktree, pid: process.pid, name: "issue", status: "idle", startedAt: 7 };
  fs.writeFileSync(path.join(sessions, `${process.pid}.json`), JSON.stringify({ ...row, peerProtocol: 1, messagingSocketPath: socketPath }));
  let invocation;
  const provider = new ClaudeProvider({
    homeDirectory: root,
    run: async (args, options) => { invocation = { args, options }; return { stdout: JSON.stringify([row]) }; },
  });

  const project = path.join(root, "project");
  const listed = await provider.list({ cwd: project });
  assert.deepEqual(invocation.args, ["agents", "--json", "--cwd", project]);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].cwd, worktree);
  assert.equal(listed[0].projectCwd, project);
});

test("Claude ask waits for idle before submitting and gives reply generation a fresh timeout", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-claude-wait-"));
  const sessions = path.join(root, ".claude", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const socketPath = path.join(root, "target.sock");
  const server = net.createServer();
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = { id: "1234abcd", sessionId: "full-id", cwd: process.cwd(), pid: process.pid, name: "target", startedAt: 7 };
  fs.writeFileSync(path.join(sessions, `${process.pid}.json`), JSON.stringify({ ...base, peerProtocol: 1, messagingSocketPath: socketPath }));
  let reads = 0;
  const events = [];
  const endpoint = {
    async start() { events.push("start"); },
    async send() { events.push("send"); return "message-1"; },
    async waitForReply(_socket, _id, options) { events.push(`reply:${options.timeoutMs}`); return { text: "OK" }; },
    async stop() { events.push("stop"); },
  };
  const provider = new ClaudeProvider({
    homeDirectory: root,
    run: async () => ({ stdout: JSON.stringify([{ ...base, status: reads++ === 0 ? "busy" : "idle" }]) }),
    endpointFactory: () => endpoint,
    wait: async () => { events.push("wait"); },
  });
  const progress = [];
  const result = await provider.ask({ id: "claude:full-id", sessionId: "full-id", projectCwd: process.cwd(), socketPath }, "hello", {
    requestId: "r", waitTimeoutMs: 10_000, replyTimeoutMs: 321, onProgress: ({ state }) => progress.push(state),
  });
  assert.equal(result.reply, "OK");
  assert.deepEqual(events, ["wait", "start", "send", "reply:321", "stop"]);
  assert.deepEqual(progress, ["waiting", "submitted", "replied"]);
});

test("Claude ask does not enqueue after its busy-wait timeout", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-claude-busy-"));
  const sessions = path.join(root, ".claude", "sessions");
  fs.mkdirSync(sessions, { recursive: true });
  const socketPath = path.join(root, "target.sock");
  const server = net.createServer();
  await new Promise((resolve) => server.listen(socketPath, resolve));
  t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const row = { id: "1234abcd", sessionId: "full-id", cwd: process.cwd(), pid: process.pid, name: "target", status: "busy", startedAt: 7 };
  fs.writeFileSync(path.join(sessions, `${process.pid}.json`), JSON.stringify({ ...row, peerProtocol: 1, messagingSocketPath: socketPath }));
  let now = 0;
  let endpointStarted = false;
  const provider = new ClaudeProvider({
    homeDirectory: root,
    run: async () => ({ stdout: JSON.stringify([row]) }),
    endpointFactory: () => ({ async start() { endpointStarted = true; } }),
    now: () => now,
    wait: async (milliseconds) => { now += milliseconds; },
  });
  await assert.rejects(provider.ask({ id: "claude:full-id", sessionId: "full-id", projectCwd: process.cwd(), socketPath }, "hello", {
    requestId: "r", waitTimeoutMs: 500, replyTimeoutMs: 2_000,
  }), { code: "TARGET_BUSY_TIMEOUT" });
  assert.equal(endpointStarted, false);
});
