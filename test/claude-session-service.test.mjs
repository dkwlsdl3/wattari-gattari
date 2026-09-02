import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ClaudeSessionService,
  parseBackgroundSessionId,
  parseClaudeAgents,
  readClaudeTranscriptPage,
} from "../src/claude-session-service.mjs";

function record(type, id, text) {
  return JSON.stringify({
    type,
    uuid: id,
    timestamp: "2026-09-02T00:00:00.000Z",
    message: { role: type, content: type === "user" ? text : [{ type: "text", text }] },
  });
}

test("validates official agents JSON and background ids", () => {
  const rows = parseClaudeAgents(JSON.stringify([{ id: "abcdef12", sessionId: "uuid", cwd: "/tmp", status: "idle" }]));
  assert.equal(rows[0].id, "abcdef12");
  assert.equal(parseBackgroundSessionId("Started in background\nabcdef12\n"), "abcdef12");
  assert.throws(() => parseClaudeAgents("{}"), { code: "CLAUDE_AGENTS_OUTPUT_INVALID" });
});

test("reads recent and older transcript pages without loading unrelated tool records", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-claude-transcript-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const transcript = path.join(directory, "session.jsonl");
  const lines = [];
  for (let index = 0; index < 240; index += 1) {
    lines.push(record(index % 2 ? "assistant" : "user", `message-${index}`, `text-${index}`));
    lines.push(JSON.stringify({ type: "progress", data: "x".repeat(120) }));
  }
  fs.writeFileSync(transcript, `${lines.join("\n")}\n`);
  const recent = await readClaudeTranscriptPage(transcript, undefined, 100);
  assert.equal(recent.messages.length, 100);
  assert.equal(recent.messages[0].text, "text-140");
  assert.equal(recent.messages.at(-1).text, "text-239");
  const older = await readClaudeTranscriptPage(transcript, recent.olderOffset, 100);
  assert.equal(older.messages[0].text, "text-40");
  assert.equal(older.messages.at(-1).text, "text-139");
});

test("lists, creates, resumes, aliases, and stops real-shaped Claude background sessions", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-claude-service-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const workspace = path.join(directory, "workspace");
  const claudeHome = path.join(directory, ".claude");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(path.join(claudeHome, "jobs"), { recursive: true });
  const rows = [];
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "agents") return { stdout: JSON.stringify(rows) };
    if (args[0] === "--background" && args.includes("--resume")) return { stdout: `${args[args.indexOf("--resume") + 1].slice(0, 8)}\n` };
    if (args[0] === "--background") {
      const shortId = "abcdef12";
      const sessionId = "abcdef12-0000-4000-8000-000000000000";
      rows.push({ id: shortId, sessionId, cwd: workspace, kind: "background", status: "idle", state: "done", name: "native" });
      return { stdout: `${shortId}\n` };
    }
    if (args[0] === "stop") {
      rows.splice(0, rows.length);
      return { stdout: "stopped\n" };
    }
    throw new Error(`unexpected args: ${args.join(" ")}`);
  };
  const service = new ClaudeSessionService({
    cwd: workspace,
    claudeHome,
    aliasCatalogPath: path.join(directory, "aliases.json"),
    run,
  });
  await service.connect();
  const created = await service.createSession({ prompt: "hello" });
  assert.equal(created.id, "claude:abcdef12");
  assert.equal(created.status, "Sleeping");
  await service.sendMessage(created.threadId, "again", created);
  await service.renameSession(created.threadId, "renamed", created);
  assert.equal((await service.listSessions())[0].name, "renamed");
  await service.stopSession(created.threadId, created);
  assert.deepEqual(await service.listSessions(), []);
  assert(calls.some((args) => args.includes("--resume")));
  await service.detach();
});

test("refuses a message while Claude is working to prevent implicit session copies", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-claude-service-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const workspace = path.join(directory, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const row = { id: "abcdef12", sessionId: "abcdef12-0000-4000-8000-000000000000", cwd: workspace, kind: "background", status: "busy", state: "working", name: "busy", pid: process.pid };
  const service = new ClaudeSessionService({
    cwd: workspace,
    claudeHome: path.join(directory, ".claude"),
    aliasCatalogPath: path.join(directory, "aliases.json"),
    run: async () => ({ stdout: JSON.stringify([row]) }),
  });
  await service.connect();
  const [session] = await service.listSessions();
  await assert.rejects(service.sendMessage(session.threadId, "do not fork", session), { code: "TURN_IN_PROGRESS" });
});

test("stops an idle live worker before resuming so Claude keeps the same session id", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-claude-service-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const workspace = path.join(directory, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const row = { id: "abcdef12", sessionId: "abcdef12-0000-4000-8000-000000000000", cwd: workspace, kind: "background", status: "idle", state: "done", name: "idle", pid: process.pid };
  const calls = [];
  const service = new ClaudeSessionService({
    cwd: workspace,
    claudeHome: path.join(directory, ".claude"),
    aliasCatalogPath: path.join(directory, "aliases.json"),
    run: async (args) => {
      calls.push(args);
      if (args[0] === "agents") return { stdout: JSON.stringify([row]) };
      if (args[0] === "stop") return { stdout: "stopped\n" };
      return { stdout: "backgrounded · abcdef12 · idle\n" };
    },
  });
  await service.connect();
  const [session] = await service.listSessions();
  await service.sendMessage(session.threadId, "continue", session);
  assert.deepEqual(calls.slice(-2).map((args) => args[0]), ["stop", "--background"]);
  assert.equal(calls.at(-1)[calls.at(-1).indexOf("--resume") + 1], row.sessionId);
});

test("opening a sleeping Claude session wakes the same id without adding a prompt", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-claude-service-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const workspace = path.join(directory, "workspace");
  const claudeHome = path.join(directory, ".claude");
  const shortId = "abcdef12";
  const sessionId = "abcdef12-0000-4000-8000-000000000000";
  const transcript = path.join(claudeHome, "projects", "workspace", `${sessionId}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.mkdirSync(path.join(claudeHome, "jobs", shortId), { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(transcript, `${record("assistant", "message-1", "ready")}\n`);
  fs.writeFileSync(path.join(claudeHome, "jobs", shortId, "state.json"), JSON.stringify({
    daemonShort: shortId,
    sessionId,
    linkScanPath: transcript,
  }));
  const row = { id: shortId, sessionId, cwd: workspace, kind: "background", status: null, state: "done", name: "sleeping" };
  const calls = [];
  const service = new ClaudeSessionService({
    cwd: workspace,
    claudeHome,
    aliasCatalogPath: path.join(directory, "aliases.json"),
    run: async (args) => {
      calls.push(args);
      if (args[0] === "agents") return { stdout: JSON.stringify([row]) };
      row.status = "idle";
      row.pid = process.pid;
      return { stdout: "backgrounded · abcdef12 · idle\n" };
    },
  });
  await service.connect();
  const [sleeping] = await service.listSessions();
  const opened = await service.openSession(shortId, sleeping);
  assert.equal(opened.status, "Awaiting input");
  assert.deepEqual(opened.messages.map((message) => message.text), ["ready"]);
  assert.deepEqual(calls.find((args) => args[0] === "--background"), ["--background", "--resume", sessionId]);
});
