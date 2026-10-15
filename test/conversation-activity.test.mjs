import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { claudeConversationRecord, codexConversationItem, mergeHistoryMessages } from "../src/session-history.mjs";

test("real Claude tool calls appear before their result and update in place without exposing reasoning", async () => {
  const fixture = JSON.parse(await fs.readFile(new URL("./fixtures/native-executions/claude.json", import.meta.url)));
  const session = { sessionId: fixture.sessionId };
  const calls = fixture.records.flatMap(row => claudeConversationRecord(row, session, 0) ?? []);
  const running = calls.find(row => row.state === "running");
  assert.ok(running); assert.match(running.text, /Wait 25 seconds/);
  const merged = mergeHistoryMessages(calls);
  const result = merged.find(row => row.id === running.id);
  assert.equal(result.state, "error"); assert.match(result.output, /Blocked/);
  assert.equal(result.text, running.text);
  assert.deepEqual(claudeConversationRecord({ type: "assistant", sessionId: session.sessionId, message: { content: [{ type: "thinking", thinking: "private" }] } }, session, 0), []);
});

test("real Codex command items appear inline and changing output replaces the same item", async () => {
  const fixture = JSON.parse(await fs.readFile(new URL("./fixtures/native-executions/codex.json", import.meta.url)));
  const entry = fixture.records.find(row => row.item.type === "commandExecution");
  const result = codexConversationItem(entry, "fallback", true);
  assert.equal(result.role, "activity"); assert.equal(result.state, "completed"); assert.ok(result.text);
  const active = codexConversationItem({ ...entry, completedAtMs: null, item: { ...entry.item, status: "inProgress", exitCode: null, aggregatedOutput: "first" } }, "fallback", true);
  assert.equal(active.state, "running");
  assert.equal(mergeHistoryMessages([active], [result]).length, 1);
  assert.equal(codexConversationItem(entry, "fallback"), null);
});
