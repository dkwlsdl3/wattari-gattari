import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { stripVTControlCharacters as plain } from "node:util";
import { buildOverviewFrame, runOverview } from "../src/overview.mjs";

const a = { id: "codex:a", nativeId: "a", provider: "codex", name: "API 검토", cwd: "/work", status: "idle" };
const b = { ...a, id: "claude:b", nativeId: "b", provider: "claude", name: "UI 구현" };
const preview = { state: "ready", input: "입력 한글\n두 번째 줄", output: "답변 첫 줄\n두 번째 답변", checkedAt: 0 };
const delay = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
function setup(t, options = {}) {
  const writes = [], calls = [];
  const input = Object.assign(new EventEmitter(), { isTTY: true, setRawMode() {}, resume() {} });
  const output = Object.assign(new EventEmitter(), { isTTY: true, columns: 150, rows: 30, write: (s) => writes.push(s) });
  const bridge = { discover: async () => ({ sessions: [a, b], warnings: [], availableProviders: ["codex", "claude"] }), preview: async (s) => { calls.push(s.id); return { input: `${s.id}-INPUT`, output: `${s.id}-OUTPUT` }; }, ...options.bridge };
  const running = runOverview({ defaultCwd: "/work", workspace: {}, refreshMs: 60000, previewDebounceMs: 1, listenForSignals: false, ...options, bridge, inputStream: input, outputStream: output });
  t.after(async () => { input.emit("end"); await running; });
  return { input, output, writes, calls, running, key: (name, extra = {}) => input.emit("keypress", "", { name, ...extra }) };
}
const cellWidth = (text) => [...text].reduce((n, char) => n + (/[^\u0000-\u10ff]/u.test(char) && /[가-힣一-龥]/u.test(char) ? 2 : 1), 0);

test("wide dock splits the selected session preview with wrapped Korean and preserved footer", () => {
  const frame = plain(buildOverviewFrame({ sessions: [a, b], selected: 1, width: 150, height: 30, preview }));
  assert.match(frame, /CODEX · API 검토/);
  assert.match(frame, /마지막 입력/); assert.match(frame, /입력 한글/); assert.match(frame, /두 번째 줄/);
  assert.match(frame, /답변 첫 줄/); assert.match(frame, /Alt\+Q/);
  assert.ok(frame.includes("│"));
  assert.ok(frame.split("\n").length <= 30);
  assert.ok(frame.split("\n").every((line) => cellWidth(line) <= 150));
});

test("preview layout respects width and height boundaries, usage row, long text and controls", () => {
  for (const width of [80, 119, 120, 150]) for (const height of [19, 20, 30]) {
    const frame = plain(buildOverviewFrame({ sessions: [a], selected: 1, width, height, providerUsage: { codex: { remainingPercent: 80 } }, preview: { ...preview, input: "\x1b]52;c;SECRET\x07" + "가나다".repeat(300), output: "abc".repeat(900) } }));
    assert.equal(frame.includes("마지막 입력"), width >= 120 && height >= 20);
    assert.ok(!frame.includes("SECRET"));
    assert.ok(frame.split("\n").every((line) => cellWidth(line) <= width), `${width}x${height}`);
    assert.ok(frame.split("\n").length <= height);
    if (width >= 120 && height >= 20) assert.match(frame, /…/);
  }
});

test("long responses scroll inside the preview pane without changing the selected session", () => {
  const output = Array.from({ length: 30 }, (_, index) => `응답-${index}`).join("\n");
  const first = plain(buildOverviewFrame({ sessions: [a, b], selected: 2, width: 150, height: 30,
    preview: { ...preview, output }, previewOutputOffset: 0 }));
  const later = plain(buildOverviewFrame({ sessions: [a, b], selected: 2, width: 150, height: 30,
    preview: { ...preview, output }, previewOutputOffset: 9 }));
  assert.match(first, /마지막 응답 \(이전 작업 포함\) · 1-9\/30/);
  assert.match(first, /응답-0/); assert.doesNotMatch(first, /응답-9/);
  assert.match(later, /마지막 응답 \(이전 작업 포함\) · 10-18\/30/);
  assert.match(later, /응답-9/); assert.doesNotMatch(later, /응답-0/);
  assert.match(later, /CLAUDE · UI 구현/);
  assert.ok(later.split("\n").every((line) => cellWidth(line) <= 150));
});

test("workspace, empty, loading, error and limited history have explicit preview placeholders", () => {
  const frame = (options) => plain(buildOverviewFrame({ sessions: [a], selected: 1, width: 150, height: 30, ...options }));
  assert.match(frame({ selected: 0 }), /세션을 선택하면/);
  assert.match(frame({ sessions: [] }), /발견된 세션이 없습니다/);
  assert.match(frame({}), /읽는 중/);
  assert.match(frame({ preview: { state: "error" } }), /읽지 못했습니다/);
  assert.match(frame({ preview: { ...preview, input: "", output: "", limited: true } }), /최근 일부/);
  assert.match(frame({ preview: { ...preview, input: "", output: "" } }), /조회 범위에 응답이 없습니다/);
});

test("preview failure shows its reason and keeps last successful data explicitly stale", () => {
  const render = (value) => plain(buildOverviewFrame({ sessions: [a], selected: 1, width: 150, height: 30, preview: value }));
  assert.match(render({ state: "error", error: "로그 파일 없음" }), /로그 파일 없음/);
  const stale = render({ ...preview, error: "읽기 권한 없음", observedAt: 0, checkedAt: 100000 });
  assert.match(stale, /입력 한글/); assert.match(stale, /답변 첫 줄/);
  assert.match(stale, /읽기 권한 없음 · 이전 조회/);
  assert.ok(stale.includes(new Date(0).toLocaleTimeString()));
});

test("actual dock key navigation selects one preview, reuses cache and suppresses narrow reads", async (t) => {
  const ui = setup(t); await delay(); assert.deepEqual(ui.calls, []);
  ui.key("down"); await delay(); assert.deepEqual(ui.calls, [a.id]);
  assert.match(ui.writes.at(-1), /codex:a-INPUT/);
  ui.key("down"); await delay(); assert.deepEqual(ui.calls, [a.id, b.id]);
  assert.match(ui.writes.at(-1), /claude:b-OUTPUT/);
  assert.ok(!ui.writes.at(-1).includes("codex:a-INPUT"));
  ui.key("up"); await delay(); assert.equal(ui.calls.length, 2);
  ui.output.columns = 100; ui.output.emit("resize"); ui.key("down"); await delay();
  assert.equal(ui.calls.length, 2); assert.ok(!ui.writes.at(-1).includes("마지막 입력"));
});

test("PageUp and PageDown scroll only the selected response", async (t) => {
  const output = Array.from({ length: 40 }, (_, index) => `long-answer-${index}`).join("\n");
  const ui = setup(t, { bridge: { preview: async (s) => ({ input: `${s.id}-INPUT`, output }) } });
  await delay(); ui.key("down"); await delay(); ui.key("down"); await delay();
  assert.match(ui.writes.at(-1), /마지막 응답 \(이전 작업 포함\) · 1-9\/40/);
  ui.key("pagedown");
  assert.match(ui.writes.at(-1), /마지막 응답 \(이전 작업 포함\) · 10-18\/40/);
  assert.match(ui.writes.at(-1), /CLAUDE · UI 구현/);
  ui.key("pageup");
  assert.match(ui.writes.at(-1), /마지막 응답 \(이전 작업 포함\) · 1-9\/40/);
});

test("preview refresh keeps the response scroll position", async (t) => {
  const output = Array.from({ length: 40 }, (_, index) => `refresh-answer-${index}`).join("\n");
  const ui = setup(t, {
    refreshMs: 30,
    previewCacheMs: 10,
    bridge: { preview: async (s) => ({ input: `${s.id}-INPUT`, output }) },
  });
  await delay(50); ui.key("down"); await delay(50); ui.key("down"); await delay(50);
  ui.key("pagedown");
  assert.match(ui.writes.at(-1), /마지막 응답 \(이전 작업 포함\) · 10-18\/40/);
  await delay(100);
  assert.match(ui.writes.at(-1), /마지막 응답 \(이전 작업 포함\) · 10-18\/40/);
});

test("actual dock drops late results after moving and closing", async (t) => {
  let resolve; const pending = new Promise((r) => { resolve = r; });
  const ui = setup(t, { bridge: { preview: () => pending } });
  await delay(); ui.key("down"); await delay(); ui.key("down");
  resolve({ input: "OLD-RESULT", output: "" });
  ui.input.emit("end"); await ui.running; const count = ui.writes.length;
  await delay(); assert.equal(ui.writes.length, count);
  assert.ok(ui.writes.every((frame) => !frame.includes("OLD-RESULT")));
});

test("actual dock preview never reads while tmux overview is hidden", async (t) => {
  const ui = setup(t, { workspace: { shouldRefreshOverview: async () => false } });
  await delay(); ui.key("down"); await delay(); assert.deepEqual(ui.calls, []);
});
