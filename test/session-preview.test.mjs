import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { messageText, previewText, readClaudePreview, SessionPreview } from "../src/session-preview.mjs";
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
