import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ClaudePreviewReader, messageText, previewText, readClaudePreview, SessionPreview } from "../src/session-preview.mjs";
import { ClaudeProvider } from "../src/providers/claude.mjs";

const delay = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const a = { id: "codex:a" }, b = { id: "claude:b" };
const session = { sessionId: "8d96d424-7a71-4552-bcc0-72870f9028ca", cwd: "/tmp/waga-proof-create-WJWBRA" };
// Reduced from the disposable Claude 2.1.259 create proof (2026-09-03).
const fixture = await fs.readFile(new URL("./fixtures/claude-preview.jsonl", import.meta.url), "utf8");
async function transcript(t, text = fixture) {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "waga-preview-"));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));
  const folder = path.join(homeDirectory, ".claude/projects/-tmp-waga-proof-create-WJWBRA");
  await fs.mkdir(folder, { recursive: true });
  const filename = path.join(folder, `${session.sessionId}.jsonl`);
  await fs.writeFile(filename, text);
  return { homeDirectory, filename };
}
function controller(t, options = {}) {
  const value = new SessionPreview({ read: async () => ({ input: "hello", output: "answer" }), visible: async () => true, changed() {}, debounceMs: 1, ...options });
  t.after(() => value.close());
  return value;
}

test("preview removes terminal controls, bidi and non-text blocks, and caps text", () => {
  assert.equal(previewText("\x1b[31mhello\x1b[0m\x1b]52;c;SECRET\x07\u202e\r\t\nworld"), "hello   \nworld");
  assert.equal(previewText(null), "");
  assert.equal(previewText("a".repeat(100000)).length, 4001);
  assert.equal(messageText("abc"), "abc");
  assert.equal(messageText({ text: "wrong" }), "");
  assert.equal(messageText([{ type: "thinking", thinking: "hidden" }, { type: "text", text: "one" }, { type: "tool_result", content: "hidden" }, { type: "text", text: "two" }]), "one\ntwo");
  assert.equal(messageText([{ type: "text", text: "a".repeat(9000) }, { type: "text", text: "NEVER" }]).length, 4001);
});

test("Claude preview reads the measured transcript without running CLI or changing it", async (t) => {
  const options = await transcript(t);
  const provider = new ClaudeProvider({ homeDirectory: options.homeDirectory, run: () => { throw new Error("must not execute"); } });
  const before = await fs.readFile(options.filename, "utf8");
  assert.deepEqual(await provider.preview(session), {
    input: "Return exactly WAGA_CLAUDE_CREATE_OK. Do not use tools.", output: "WAGA_CLAUDE_CREATE_OK", limited: false,
  });
  assert.equal(await fs.readFile(options.filename, "utf8"), before);
});

test("Claude preview retains the last real input behind more than 256KiB of tool activity", async (t) => {
  const rows = fixture.trim().split("\n");
  const tool = JSON.stringify({ type: "user", sessionId: session.sessionId, message: { content: [{ type: "tool_result", content: "x".repeat(600000) }] } });
  const options = await transcript(t, [rows[0], tool, rows[1], ""].join("\n"));
  const provider = new ClaudeProvider({ homeDirectory: options.homeDirectory });
  const result = await provider.preview(session);
  assert.equal(result.input, "Return exactly WAGA_CLAUDE_CREATE_OK. Do not use tools.");
  assert.equal(result.output, "WAGA_CLAUDE_CREATE_OK");
});

function measuredReader({ maxRead = Infinity, afterRead = () => {} } = {}) {
  const counts = { bytes: 0, reads: 0, closes: 0 };
  const reader = new ClaudePreviewReader({ open: async (...args) => {
    const file = await fs.open(...args);
    return {
      stat: () => file.stat(),
      read: async (buffer, offset, size, position) => {
        const result = await file.read(buffer, offset, Math.min(size, maxRead), position);
        counts.bytes += result.bytesRead; counts.reads++; await afterRead(); return result;
      },
      close: async () => { counts.closes++; await file.close(); },
    };
  } });
  return { reader, counts };
}

test("Claude initial search stops at latest messages; unchanged logs need no content reads and append reads only delta", async (t) => {
  const options = await transcript(t, "old\n".repeat(300000) + fixture);
  const { reader, counts } = measuredReader();
  const initial = await reader.read(session, options);
  assert.equal(initial.output, "WAGA_CLAUDE_CREATE_OK");
  assert.equal(counts.bytes, 256 * 1024, "do not scan older history after both messages are found");
  const firstBytes = counts.bytes;
  initial.input = "MUTATED RETURN VALUE";
  assert.match((await reader.read(session, options)).input, /^Return exactly/);
  assert.equal(counts.bytes, firstBytes, "unchanged file only needs stat");
  const addition = JSON.stringify({ type: "assistant", sessionId: session.sessionId, message: { content: [{ type: "text", text: "NEW OUTPUT" }] } }) + "\n";
  await fs.appendFile(options.filename, addition);
  assert.deepEqual(await reader.read(session, options), { input: "Return exactly WAGA_CLAUDE_CREATE_OK. Do not use tools.", output: "NEW OUTPUT", limited: false });
  assert.equal(counts.bytes - firstBytes, Buffer.byteLength(addition));
  assert.equal(counts.closes, 3);
});

test("Claude incremental reader retries incomplete UTF-8 records from the last complete newline", async (t) => {
  const options = await transcript(t);
  const { reader } = measuredReader({ maxRead: 31 }); // Real read() may return less than requested.
  await reader.read(session, options);
  const line = Buffer.from(JSON.stringify({ type: "user", sessionId: session.sessionId, message: { content: "새 입력" } }) + "\n");
  const split = line.indexOf(Buffer.from("새")) + 1;
  await fs.appendFile(options.filename, line.subarray(0, split));
  const partial = await reader.read(session, options);
  assert.match(partial.input, /^Return exactly/); assert.equal(partial.limited, true);
  await fs.appendFile(options.filename, line.subarray(split));
  const complete = await reader.read(session, options);
  assert.equal(complete.input, "새 입력"); assert.equal(complete.limited, false);
});

test("Claude cache invalidates on truncation, same-size rewrite and inode replacement", async (t) => {
  const options = await transcript(t);
  const reader = new ClaudePreviewReader();
  await reader.read(session, options);
  const line = (text) => JSON.stringify({ type: "user", sessionId: session.sessionId, message: { content: text } }) + "\n";
  await fs.writeFile(options.filename, line("SHORT"));
  assert.deepEqual(await reader.read(session, options), { input: "SHORT", output: "", limited: false });
  await fs.writeFile(options.filename, line("OTHER"));
  await fs.utimes(options.filename, new Date(), new Date(Date.now() + 10000));
  assert.equal((await reader.read(session, options)).input, "OTHER");
  await fs.rename(options.filename, options.filename + ".old");
  await fs.writeFile(options.filename, fixture);
  assert.match((await reader.read(session, options)).input, /^Return exactly/);
});

test("Claude reader bounds oversized records and tolerates null JSON without losing valid input", async (t) => {
  const options = await transcript(t, fixture + JSON.stringify({ type: "attachment", data: "x".repeat(5 * 1024 * 1024) }) + "\nnull\nfalse\n");
  const result = await readClaudePreview(session, options);
  assert.match(result.input, /^Return exactly/); assert.equal(result.output, "WAGA_CLAUDE_CREATE_OK");
  assert.equal(result.limited, true);
});

test("Claude scan can be cancelled between chunks and never caches a partially read result", async (t) => {
  const options = await transcript(t, fixture + "\n".repeat(600000));
  const controller = new AbortController();
  const { reader, counts } = measuredReader({ afterRead: () => controller.abort() });
  await assert.rejects(reader.read(session, { ...options, signal: controller.signal }));
  assert.equal(counts.reads, 1); assert.equal(counts.closes, 1);
  const result = await reader.read(session, options);
  assert.match(result.input, /^Return exactly/);
  assert.ok(counts.reads > 1);
});

test("short read caused by concurrent truncation reports a stable error and closes the file", async () => {
  let closed = false;
  const reader = new ClaudePreviewReader({ open: async () => ({
    stat: async () => ({ size: 10, isFile: () => true }), read: async () => ({ bytesRead: 0 }), close: async () => { closed = true; },
  }) });
  await assert.rejects(reader.read(session, { homeDirectory: "/tmp/waga-proof-missing" }), { code: "ESTALE" });
  assert.equal(closed, true);
});

test("Claude offset caches are bounded to twenty identities", async (t) => {
  const options = await transcript(t);
  const { reader, counts } = measuredReader();
  for (let i = 0; i < 21; i++) {
    const id = `${String(i).padStart(8, "0")}-0000-0000-0000-000000000000`;
    await fs.writeFile(path.join(path.dirname(options.filename), `${id}.jsonl`), fixture.replaceAll(session.sessionId, id));
    await reader.read({ ...session, sessionId: id }, options);
  }
  const before = counts.reads;
  await reader.read({ ...session, sessionId: "00000000-0000-0000-0000-000000000000" }, options);
  assert.ok(counts.reads > before);
});

test("transient preview failures retain previous content and its observation time", async (t) => {
  let now = 100, failed = false;
  const cache = controller(t, { now: () => now, cacheMs: 10, read: async () => {
    if (failed) throw Object.assign(new Error("PRIVATE FILE PATH"), { code: "ENOENT" });
    return { input: "SAVED INPUT", output: "SAVED OUTPUT" };
  } });
  cache.select(a); await delay();
  const observedAt = cache.snapshot(a).observedAt;
  now += 20; failed = true; cache.select(a); await delay();
  assert.equal(cache.snapshot(a).input, "SAVED INPUT");
  assert.equal(cache.snapshot(a).state, "ready");
  assert.equal(cache.snapshot(a).observedAt, observedAt);
  assert.equal(cache.snapshot(a).error, "로그 파일 없음");
  assert.ok(!JSON.stringify(cache.snapshot(a)).includes("PRIVATE"));
  now += 20; failed = false; cache.select(a); await delay();
  assert.equal(cache.snapshot(a).error, undefined);
  assert.equal(cache.snapshot(a).observedAt, now);
});

test("preview reports safe error categories without exposing provider error text", async (t) => {
  for (const [error, label] of [
    [{ code: "EACCES" }, "읽기 권한 없음"], [{ code: "ESTALE" }, "로그 변경 중"],
    [{ code: "CODEX_RPC_TIMEOUT" }, "조회 시간 초과"], [{ name: "TimeoutError" }, "조회 시간 초과"],
    [{ code: "ECONNREFUSED" }, "연결 불가"], [{}, "조회 오류"],
  ]) {
    const cache = controller(t, { read: async () => { throw { ...error, message: "SECRET" }; } });
    cache.select(a); await delay();
    assert.equal(cache.snapshot(a).state, "error"); assert.equal(cache.snapshot(a).error, label);
    assert.ok(!JSON.stringify(cache.snapshot(a)).includes("SECRET"));
  }
});

test("same session moving cwd refreshes immediately and discards an old-path in-flight error", async (t) => {
  const old = { ...b, cwd: "/tmp/waga-proof-old" }, moved = { ...b, cwd: "/tmp/waga-proof-new" };
  const pending = deferred();
  let now = 100, calls = 0;
  const cache = controller(t, { now: () => now, cacheMs: 10, read: async (selected) => {
    calls++;
    if (calls === 2) { await pending.promise; throw Object.assign(new Error("old path"), { code: "ENOENT" }); }
    return { input: selected.cwd, output: "answer" };
  } });
  cache.select(old); await delay();
  cache.select(moved); await delay();
  assert.equal(calls, 2, "cwd change bypasses a fresh cache");
  cache.select(old); pending.resolve(); await delay(40);
  assert.equal(cache.snapshot(old).input, old.cwd);
  assert.equal(cache.snapshot(old).error, undefined, "aborted old-path error cannot overwrite the cache");
  now += 20; cache.select(moved); await delay();
  assert.equal(cache.snapshot(moved).input, moved.cwd);
});

test("Claude preview ignores tool results, meta, sidechain, foreign session and peer messages", async (t) => {
  const row = { sessionId: session.sessionId, type: "user", message: { content: "WRONG" } };
  const extras = [
    { ...row, isMeta: true }, { ...row, isSidechain: true }, { ...row, sessionId: "foreign" },
    { ...row, origin: { kind: "agent" } }, { ...row, toolUseResult: {} },
    { ...row, message: { content: [{ type: "tool_result", content: "WRONG" }] } },
    { ...row, type: "assistant", message: { content: [{ type: "thinking", thinking: "WRONG" }, { type: "tool_use", name: "Bash" }] } },
  ];
  const options = await transcript(t, fixture + extras.map((x) => JSON.stringify(x)).join("\n") + "\n");
  const result = await readClaudePreview(session, options);
  assert.equal(result.output, "WAGA_CLAUDE_CREATE_OK");
  assert.match(result.input, /^Return exactly/);
});

test("Claude preview bounds tail, handles partial/malformed lines and keeps separate latest messages", async (t) => {
  const latest = JSON.stringify({ type: "user", sessionId: session.sessionId, message: { content: [{ type: "text", text: "NEXT PROMPT" }] } });
  const options = await transcript(t, "x".repeat(300000) + "\n" + fixture + "bad json\n" + latest + "\n{unfinished");
  const result = await readClaudePreview(session, options);
  assert.deepEqual(result, { input: "NEXT PROMPT", output: "WAGA_CLAUDE_CREATE_OK", limited: true });
  await fs.writeFile(options.filename, "");
  assert.deepEqual(await readClaudePreview(session, options), { input: "", output: "", limited: false });
  await fs.writeFile(options.filename, "bad json\n");
  assert.equal((await readClaudePreview(session, options)).limited, true);
});

test("Claude preview rejects missing/invalid identities, nonfiles and cancellation", async (t) => {
  const options = await transcript(t);
  for (const invalid of [{ ...session, sessionId: "../../escape" }, { ...session, cwd: "relative" }]) {
    await assert.rejects(readClaudePreview(invalid, options), /identity/);
  }
  await assert.rejects(readClaudePreview(session, { ...options, signal: AbortSignal.abort() }));
  await fs.unlink(options.filename);
  await assert.rejects(readClaudePreview(session, options), { code: "ENOENT" });
  await fs.mkdir(options.filename);
  await assert.rejects(readClaudePreview(session, options), /not a file/);
});

test("Claude image-only latest input is not silently replaced by an older prompt", async (t) => {
  const options = await transcript(t, fixture + JSON.stringify({ type: "user", sessionId: session.sessionId, message: { content: [{ type: "image", source: {} }] } }) + "\n");
  assert.equal((await readClaudePreview(session, options)).input, "[텍스트 없는 입력]");
});

test("selection is debounced; rapid navigation queries only the final identity and caches it", async (t) => {
  const calls = []; let changes = 0; let now = 100;
  const cache = controller(t, { read: async (s) => { calls.push(s.id); return { input: s.id, output: "ok" }; }, changed: () => { changes++; }, now: () => now, cacheMs: 50 });
  assert.equal(cache.snapshot(null), null);
  cache.select(a); cache.select(b); cache.select(a);
  assert.equal(cache.snapshot(a).state, "loading");
  await delay();
  assert.deepEqual(calls, [a.id]);
  assert.equal(changes, 1);
  cache.select(null); cache.select(a); await delay();
  assert.equal(calls.length, 1);
  now += 51; cache.select(a); await delay();
  assert.equal(calls.length, 2);
});

test("late old selection results never paint or replace the new session; one read at a time", async (t) => {
  const pending = deferred(); const calls = []; let oldSignal;
  const cache = controller(t, { read: async (s, { signal }) => {
    calls.push(s.id); if (s.id === a.id) { oldSignal = signal; return pending.promise; }
    return { input: "B", output: "B" };
  } });
  cache.select(a); await delay(); cache.select(b); await delay();
  assert.equal(oldSignal.aborted, true);
  assert.deepEqual(calls, [a.id]);
  pending.resolve({ input: "STALE", output: "STALE" }); await delay();
  assert.equal(cache.snapshot(a).state, "loading");
  assert.equal(cache.snapshot(b).input, "B");
  assert.deepEqual(calls, [a.id, b.id]);
});

test("return to the same identity during an aborted read schedules a replacement", async (t) => {
  const pending = deferred(); let calls = 0;
  const cache = controller(t, { read: async () => ++calls === 1 ? pending.promise : { input: "FRESH", output: "" } });
  cache.select(a); await delay(); cache.select(b); cache.select(a);
  pending.resolve({ input: "STALE", output: "" }); await delay();
  assert.equal(calls, 2); assert.equal(cache.snapshot(a).input, "FRESH");
});

test("hidden dock does not query or paint; visibility failure and read failure are isolated", async (t) => {
  let visible = false, calls = 0, changes = 0;
  const cache = controller(t, { visible: async () => { if (visible === "error") throw new Error("tmux failed"); return visible; }, read: async () => { calls++; throw new Error("SECRET"); }, changed: () => changes++ });
  cache.select(a); await delay(); assert.equal(calls, 0);
  visible = "error"; cache.select(a); await delay(); assert.equal(calls, 0);
  visible = true; cache.select(a); await delay();
  assert.equal(calls, 1); assert.equal(changes, 1);
  assert.equal(cache.snapshot(a).state, "error");
  assert.ok(!JSON.stringify(cache.snapshot(a)).includes("SECRET"));
});

test("preview completion cannot paint a newly hidden dock", async (t) => {
  let visible = true, changes = 0; const pending = deferred();
  const cache = controller(t, { visible: async () => visible, read: () => pending.promise, changed: () => changes++ });
  cache.select(a); await delay(); visible = false;
  pending.resolve({ input: "ok", output: "ok" }); await delay();
  assert.equal(changes, 0);
});

test("close cancels pending and scheduled reads, discards cache and forbids late rendering", async (t) => {
  let calls = 0, changes = 0; const pending = deferred();
  const cache = controller(t, { read: () => { calls++; return pending.promise; }, changed: () => changes++ });
  cache.select(a); await delay(); cache.close();
  pending.resolve({ input: "late", output: "late" }); await delay();
  cache.select(b); await delay(); assert.equal(calls, 1); assert.equal(changes, 0);
  const scheduled = controller(t, { read: async () => { calls++; return {}; } });
  scheduled.select(a); scheduled.close(); await delay(); assert.equal(calls, 1);
});

test("preview cache evicts older entries beyond twenty sessions", async (t) => {
  const cache = controller(t);
  for (let i = 0; i < 21; i++) { cache.select({ id: String(i) }); await delay(5); }
  assert.equal(cache.snapshot({ id: "0" }).state, "loading");
  assert.equal(cache.snapshot({ id: "20" }).state, "ready");
});
