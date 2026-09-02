import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ClaudeSessionService, parseClaudeAgents } from "../src/claude-session-service.mjs";

test("validates the current claude agents JSON contract", () => {
  const rows = parseClaudeAgents(JSON.stringify([{
    id: "abcdef12",
    sessionId: "abcdef12-0000-4000-8000-000000000000",
    cwd: "/tmp",
    kind: "background",
    status: "idle",
  }]));
  assert.equal(rows[0].id, "abcdef12");
  assert.throws(() => parseClaudeAgents("{}"), { code: "CLAUDE_AGENTS_OUTPUT_INVALID" });
  assert.throws(() => parseClaudeAgents('[{"sessionId":"uuid","cwd":"/tmp"}]'), { code: "CLAUDE_AGENTS_OUTPUT_INVALID" });
});

function fixture(t, rowOverrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-claude-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  const workspace = path.join(directory, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  const rows = [{
    id: "abcdef12",
    sessionId: "abcdef12-0000-4000-8000-000000000000",
    cwd: workspace,
    kind: "background",
    status: "idle",
    state: "done",
    name: "native",
    pid: process.pid,
    startedAt: "2026-09-02T00:00:00.000Z",
    ...rowOverrides,
  }];
  const calls = [];
  const service = new ClaudeSessionService({
    cwd: workspace,
    claudeHome: path.join(directory, ".claude"),
    aliasCatalogPath: path.join(directory, "aliases.json"),
    run: async (args) => {
      calls.push(args);
      if (args[0] === "agents") return { stdout: JSON.stringify(rows) };
      if (args[0] === "stop") {
        rows[0].status = null;
        rows[0].pid = null;
        return { stdout: "stopped\n" };
      }
      throw new Error(`unexpected args: ${args.join(" ")}`);
    },
  });
  return { service, rows, calls };
}

test("lists current-workspace Claude sessions and keeps native attach targets", async (t) => {
  const { service } = fixture(t);
  await service.connect();
  const [session] = await service.listSessions();
  assert.equal(session.id, "claude:abcdef12");
  assert.equal(session.threadId, "abcdef12");
  assert.equal(session.status, "Awaiting input");
  assert.equal(session.routable, true);
  await service.detach();
});

test("renames only Waga metadata and stops a background session through Claude CLI", async (t) => {
  const { service, calls } = fixture(t);
  await service.connect();
  const [session] = await service.listSessions();
  await service.renameSession(session.threadId, "renamed", session);
  assert.equal((await service.listSessions())[0].name, "renamed");
  await service.stopSession(session.threadId, session);
  assert.deepEqual(calls.at(-1), ["stop", "abcdef12"]);
  assert.deepEqual(await service.listSessions(), []);
});

test("does not advertise non-background Claude surfaces as attach targets", async (t) => {
  const { service } = fixture(t, { kind: "foreground" });
  await service.connect();
  assert.deepEqual(await service.listSessions(), []);
});
