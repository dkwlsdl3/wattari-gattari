import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ClaudeProvider, parseClaudeAgents, parseClaudeBackgroundId } from "../src/providers/claude.mjs";
import { WAGA_SESSION_INSTRUCTIONS } from "../src/managed-session-instructions.mjs";
import { ClaudeTitleSync } from "../src/claude-title-sync.mjs";
import { buildOverviewFrame } from "../src/overview.mjs";

// Anonymized from `claude agents --json` on 2026-09-08: interactive rows have no attach id.
const mixedAgents = JSON.parse(fs.readFileSync(new URL("./fixtures/claude-agents-mixed.json", import.meta.url), "utf8"));

// Anonymized from Claude Code 2.1.294 `agents --json` on 2026-10-08.
const nativeStatuses = JSON.parse(fs.readFileSync(new URL("./fixtures/claude-agents-status.json", import.meta.url), "utf8"));

test("Claude discovery and dock distinguish inactive tasks, input waits, completion and live work", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-status-"));
  const registryDirectory = path.join(root, ".claude", "sessions");
  fs.mkdirSync(registryDirectory, { recursive: true });
  const socketPath = path.join(root, "peer.sock");
  const server = net.createServer();
  await new Promise(resolve => server.listen(socketPath, resolve));
  t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const expected = ["idle", "needs-input", "done", "working"];
  const listed = [];
  for (const [index, measured] of nativeStatuses.entries()) {
    const row = { ...measured, pid: process.pid, cwd: root };
    fs.writeFileSync(path.join(registryDirectory, `${process.pid}.json`), JSON.stringify({
      ...row, peerProtocol: 1, messagingSocketPath: socketPath,
    }));
    const provider = new ClaudeProvider({ homeDirectory: root, run: async () => ({ stdout: JSON.stringify([row]) }) });
    const sessions = await provider.list();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].status, expected[index], row.name);
    listed.push(sessions[0]);
  }
  const frame = buildOverviewFrame({ sessions: listed, width: 140, height: 24 }).replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(frame, /idle task[^\n]*idle/);
  assert.match(frame, /input required[^\n]*needs input/);
  assert.match(frame, /finished task[^\n]*done/);
  assert.match(frame, /active task[^\n]*working/);
  assert.match(frame, /1 need input\s+1 working\s+1 idle\s+1 done/);
});

test("Claude completed sessions remain eligible for a new peer query", async () => {
  let sent = 0;
  const provider = new ClaudeProvider({ endpointFactory: () => ({
    async start() {}, async send() { sent++; return "message-1"; },
    async waitForDisposition() { return { state: "accepted" }; },
    async waitForReply() { return { text: "OK" }; }, async stop() {},
  }) });
  const session = { id: "claude:full-id", sessionId: "full-id", socketPath: "/tmp/proof.sock", status: "done" };
  provider.list = async () => [session];
  const result = await provider.ask(session, "hello", { requestId: "r" });
  assert.equal(sent, 1);
  assert.equal(result.reply, "OK");
});

test("mixed native agents output preserves background sessions when an interactive row has no id", () => {
  assert.deepEqual(parseClaudeAgents(JSON.stringify(mixedAgents)), mixedAgents.slice(0, 2));
  assert.deepEqual(parseClaudeAgents(JSON.stringify([mixedAgents[2]])), []);
  for (const row of [null, {}, { ...mixedAgents[0], id: undefined }, { ...mixedAgents[2], kind: "unknown" }]) {
    assert.throws(() => parseClaudeAgents(JSON.stringify([mixedAgents[0], row])), { code: "CLAUDE_AGENTS_INVALID" });
  }
});

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
    titleSync: { settings: () => '{"hooks":{}}' },
    run: async (args, options) => {
      invocation = { args, options };
      return { stdout: "backgrounded · 1234abcd · task\n" };
    },
  });
  const result = await provider.create("review this change", { cwd: "/work/project" });
  assert.deepEqual(result, { provider: "claude", nativeId: "1234abcd" });
  assert.deepEqual(invocation, {
    args: ["--bg", "--settings", '{"hooks":{}}', "--append-system-prompt", WAGA_SESSION_INSTRUCTIONS, "--", "review this change"],
    options: { cwd: "/work/project" },
  });
});

test("Claude create applies the routed model and effort to the new background agent", async () => {
  let invocation;
  const provider = new ClaudeProvider({
    titleSync: { settings: () => '{"hooks":{}}' },
    run: async (args, options) => {
      invocation = { args, options };
      return { stdout: "backgrounded · 1234abcd · routed\n" };
    },
  });
  await provider.create("inspect the issue", {
    cwd: "/work/sample-app",
    model: "fable",
    effort: "high",
  });
  assert.deepEqual(invocation, {
    args: ["--bg", "--model", "fable", "--effort", "high", "--settings", '{"hooks":{}}', "--append-system-prompt", WAGA_SESSION_INSTRUCTIONS, "--", "inspect the issue"],
    options: { cwd: "/work/sample-app" },
  });
});

test("Claude create applies provider execution settings to the new background agent", async () => {
  let invocation;
  const provider = new ClaudeProvider({
    titleSync: { settings: () => '{"hooks":{}}' },
    run: async (args, options) => {
      invocation = { args, options };
      return { stdout: "backgrounded · 1234abcd · configured\n" };
    },
  });
  await provider.create("run the configured task", {
    cwd: "/work/sample-app",
    executionSettings: {
      permissionMode: "acceptEdits",
      options: { bare: true, strictMcpConfig: true },
    },
  });
  assert.deepEqual(invocation, {
    args: ["--bg", "--permission-mode", "acceptEdits", "--bare", "--strict-mcp-config", "--settings", "{\"hooks\":{}}", "--append-system-prompt", WAGA_SESSION_INSTRUCTIONS, "--", "run the configured task"],
    options: { cwd: "/work/sample-app" },
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
  assert.deepEqual(result, { target: "claude:full-id", renamed: true, name: "review UI", nameSync: "local" });
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
  const endpoint = { async start(value) { endpointCalls.push(["start", value]); }, async send(_socket, text) { endpointCalls.push(["send", text]); return "message-1"; }, async waitForDisposition() { return { state: "accepted" }; }, async waitForReply() { return { text: "OK" }; }, async stop() { endpointCalls.push(["stop"]); } };
  const provider = new ClaudeProvider({
    homeDirectory: root,
    run: async () => ({ stdout: JSON.stringify([row, mixedAgents[2]]) }),
    endpointFactory: () => endpoint,
    aliasCatalog: { load: () => new Map([["claude:full-id", "renamed target"]]) },
  });
  const listed = await provider.list({ cwd: process.cwd() });
  assert.equal(listed.length, 1, "interactive sessions must not suppress a live attachable session");
  assert.equal(listed[0].id, "claude:full-id");
  assert.equal(listed[0].name, "renamed target");
  assert.equal(listed[0].nativeId, "1234abcd");
  const answer = await provider.ask(listed[0], "hello", { requestId: "r", timeoutMs: 9 });
  assert.equal(answer.reply, "OK");
  assert.match(endpointCalls.find(([kind]) => kind === "send")[1], /trust: untrusted/);
});

test("Claude discovery shows pending titles then follows native names instead of old aliases", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-title-provider-"));
  const server = net.createServer();
  t.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const socketPath = path.join(root, "target.sock");
  await new Promise((resolve) => server.listen(socketPath, resolve));
  const sessionId = "26bce3ae-3d65-4f9a-b3a1-bb8c6d3bc247";
  const row = { id: "26bce3ae", sessionId, cwd: root, pid: process.pid, name: "native", status: "idle" };
  fs.mkdirSync(path.join(root, ".claude", "sessions"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "sessions", `${process.pid}.json`), JSON.stringify({ ...row, peerProtocol: 1, messagingSocketPath: socketPath }));
  const titleSync = new ClaudeTitleSync(path.join(root, "sync"));
  const provider = new ClaudeProvider({ homeDirectory: root, titleSync, aliasCatalog: { load: () => new Map([[`claude:${sessionId}`, "legacy"]]) }, run: async () => ({ stdout: JSON.stringify([row]) }) });
  assert.equal((await provider.list())[0].name, "legacy");
  titleSync.hook({ session_id: sessionId, hook_event_name: "SessionStart" });
  const ready = (await provider.list())[0];
  assert.equal(ready.name, "native");
  await provider.rename(ready, "pending");
  const pending = (await provider.list())[0];
  assert.equal(pending.name, "pending");
  assert.equal(pending.nameSync, "pending");
  titleSync.hook({ session_id: sessionId, hook_event_name: "UserPromptSubmit" });
  row.name = "pending";
  assert.equal((await provider.list())[0].nameSync, "native");
  row.name = "native changed later";
  assert.equal((await provider.list())[0].name, row.name);
  fs.writeFileSync(path.join(root, "sync", `${sessionId}.ready.json`), "invalid");
  assert.equal((await provider.list()).length, 1);
});

test("Claude provider fetches optional usage at most once per cache window", async () => {
  let now = 1_000;
  let reads = 0;
  const provider = new ClaudeProvider({
    run: async () => ({ stdout: "[]" }),
    now: () => now,
    usageCacheMs: 5 * 60_000,
    usageReader: async () => {
      reads += 1;
      return { weekly: { remainingPercent: reads === 1 ? 6 : 5 } };
    },
  });

  await provider.list();
  await provider.list({ includeUsage: true });
  now += 3_000;
  await provider.list({ includeUsage: true });
  assert.equal(reads, 1);
  assert.equal(provider.usageSnapshot().weekly.remainingPercent, 6);

  now += 5 * 60_000;
  await provider.list({ includeUsage: true });
  assert.equal(reads, 2);
  assert.equal(provider.usageSnapshot().weekly.remainingPercent, 5);
});

test("Claude provider shares an in-flight usage request across concurrent discovery", async () => {
  let resolveUsage;
  let reads = 0;
  const provider = new ClaudeProvider({
    run: async () => ({ stdout: "[]" }),
    usageReader: async () => {
      reads += 1;
      return new Promise((resolve) => { resolveUsage = resolve; });
    },
  });

  const first = provider.list({ includeUsage: true });
  const second = provider.list({ includeUsage: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  resolveUsage({ weekly: { remainingPercent: 5 } });
  await Promise.all([first, second]);
  assert.equal(provider.usageSnapshot().weekly.remainingPercent, 5);
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

test("Claude ask queues while busy and uses the reply deadline after submission", async () => {
  const events = [];
  const provider = new ClaudeProvider({
    endpointFactory: () => ({
      async start() { events.push("start"); },
      async send() { events.push("send"); return "message-1"; },
      async waitForDisposition() { return { state: "accepted" }; },
      async waitForReply(_socket, _id, options) { events.push(`reply:${options.timeoutMs}`); return { text: "OK" }; },
      async stop() { events.push("stop"); },
    }),
    now: () => 0,
    run: async () => { throw new Error("must not wait for idle before sending"); },
  });
  provider.list = async () => [{ id: "claude:full-id", sessionId: "full-id", socketPath: "/tmp/proof.sock", status: "working" }];
  const progress = [];
  const result = await provider.ask({ id: "claude:full-id", sessionId: "full-id", socketPath: "/tmp/proof.sock", status: "working" }, "hello", {
    requestId: "r", waitTimeoutMs: 10_000, replyTimeoutMs: 321, onProgress: ({ state }) => progress.push(state),
  });
  assert.equal(result.reply, "OK");
  assert.deepEqual(events, ["start", "send", "reply:321", "stop"]);
  assert.deepEqual(progress, ["submitting", "submitted", "accepted", "reply-received", "replied"]);
});

test("Claude held peer request fails without resending and closes the endpoint", async () => {
  let sent = 0, stopped = 0;
  const provider = new ClaudeProvider({ endpointFactory: () => ({
    async start() {}, async send() { sent++; return "message-1"; },
    async waitForDisposition() { throw Object.assign(new Error("approval required"), { code: "MESSAGE_HELD" }); },
    async stop() { stopped++; },
  }) });
  provider.list = async () => [{ id: "claude:full-id", sessionId: "full-id", socketPath: "/tmp/proof.sock", status: "needs-input" }];
  await assert.rejects(provider.ask({ id: "claude:full-id", sessionId: "full-id", socketPath: "/tmp/proof.sock" }, "hello", { requestId: "r" }), { code: "MESSAGE_HELD" });
  assert.equal(sent, 1);
  assert.equal(stopped, 1);
});
