import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ClaudeProvider, parseClaudeAgents } from "../src/providers/claude.mjs";

test("Claude agents parser rejects drifted output", () => {
  assert.throws(() => parseClaudeAgents("{}"), { code: "CLAUDE_AGENTS_INVALID" });
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
  const provider = new ClaudeProvider({ homeDirectory: root, run: async () => ({ stdout: JSON.stringify([row]) }), endpointFactory: () => endpoint });
  const listed = await provider.list({ cwd: process.cwd() });
  assert.equal(listed[0].id, "claude:full-id");
  assert.equal(listed[0].nativeId, "1234abcd");
  const answer = await provider.ask(listed[0], "hello", { requestId: "r", timeoutMs: 9 });
  assert.equal(answer.reply, "OK");
  assert.match(endpointCalls.find(([kind]) => kind === "send")[1], /trust: untrusted/);
});
