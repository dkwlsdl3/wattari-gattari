import assert from "node:assert/strict";
import test from "node:test";
import { initHistoryStream } from "../src/web/history-stream.mjs";
import { mergeMessages, conversationItems } from "../src/web/conversation.mjs";

test("session switching rejects queued old stream output and reconnect restores live state", () => {
  const sources = [], pages = [], errors = [];
  class Source { constructor(url) { this.url = url; sources.push(this); } close() { this.closed = true; } }
  const stream = initHistoryStream({ EventSourceClass: Source, onPage: (...args) => pages.push(args), onError: text => errors.push(text) });
  const emit = (source, text) => source.onmessage({ data: JSON.stringify({ messages: [{ id: "a", role: "assistant", text }] }) });
  stream.sync({ id: "claude:a", cwd: "/tmp/a" }); emit(sources[0], "first"); assert.equal(stream.live(), true);
  stream.sync({ id: "codex:b", cwd: "/tmp/b" }); assert.equal(sources[0].closed, true);
  emit(sources[0], "must not appear"); assert.equal(pages.length, 1);
  emit(sources[1], "new"); sources[1].onerror(); assert.equal(stream.live(), false); assert.equal(errors.length, 1);
  emit(sources[1], "newer"); assert.equal(stream.live(), true);
  stream.close(); emit(sources[1], "late"); assert.equal(pages.length, 3);
});

test("partial response and tool result update existing conversation rows while retaining loaded history", () => {
  const earlier = [{ id: "user", role: "user", text: "question" }, { id: "call", role: "activity", tool: "Bash", text: "run checks", state: "running" }];
  const next = mergeMessages(earlier, [{ id: "call", role: "activity", state: "completed", output: "passed" }, { id: "answer", role: "assistant", text: "part" }]);
  const final = mergeMessages(next, [{ id: "answer", role: "assistant", text: "partial response complete" }]);
  const rows = conversationItems({ history: final });
  assert.deepEqual(rows.map(row => row.id), ["user", "call", "answer"]);
  assert.equal(rows[1].text, "run checks"); assert.equal(rows[1].output, "passed"); assert.equal(rows[1].label, "Bash");
  assert.equal(rows[2].text, "partial response complete");
});
