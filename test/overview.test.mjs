import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test, { afterEach } from "node:test";

import {
  applyOverviewOrder,
  buildOverviewFrame,
  buildOverviewTree,
  formatClaudeUsage,
  formatCodexUsage,
  moveOverviewSession,
  nativeReturnHint,
  reconcileDiscoveredSessions,
  reconcileOverviewOrder,
  runOverview as startOverview,
  selectOverviewSessions,
} from "../src/overview.mjs";

const runningOverviews = new Set();
function runOverview(options) {
  const running = startOverview(options);
  runningOverviews.add({ input: options.inputStream, running });
  return running;
}
afterEach(async () => {
  const pending = [...runningOverviews];
  runningOverviews.clear();
  for (const { input } of pending) { input.emit("end"); input.emit("close"); }
  await Promise.all(pending.map(({ running }) => running));
});

const sessions = [
  { id: "codex:1", provider: "codex", status: "idle", name: "API 검토", cwd: "/work/api", updatedAt: 20 },
  { id: "claude:2", provider: "claude", status: "working", name: "UI 구현", cwd: "/work/ui", updatedAt: 10 },
  { id: "codex:3", provider: "codex", status: "needs-input", name: "배포 확인", cwd: "/work/ops", updatedAt: 5 },
];

function ttyInput() {
  return Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
  });
}

function capturedOutput() {
  const writes = [];
  return Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 100,
    rows: 20,
    writes,
    write(chunk) { writes.push(String(chunk)); },
  });
}

function rawTtyInput() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  return input;
}

async function waitFor(check, timeoutMs = 200) {
  const deadline = performance.now() + timeoutMs;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error(`condition was not met within ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function plain(value) {
  return String(value).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
}

function selectedSessionName(output) {
  const frame = plain(output.writes.at(-1));
  return frame.split("\n").find((line) => line.includes("›") && /CODEX|CLAUDE/.test(line))
    ?.match(/(?:CODEX|CLAUDE)\s+([^\s]+)/)?.[1] ?? null;
}

function pressAlt(input, name) {
  input.emit("keypress", "", { name, meta: true });
}

test("overview preserves supplied session order instead of sorting by status", () => {
  assert.deepEqual(selectOverviewSessions(sessions).map((session) => session.id), ["codex:1", "claude:2", "codex:3"]);
});

test("overview does not silently hide sessions beyond the first forty", () => {
  const many = Array.from({ length: 60 }, (_, index) => ({ ...sessions[index % 3], id: `session-${index}` }));
  assert.equal(selectOverviewSessions(many).length, 60);
  assert.equal(selectOverviewSessions(many, { limit: 5 }).length, 5);
});

test("overview reconciles discovered sessions with manual workspace order", () => {
  const order = reconcileOverviewOrder(new Map([["/work/api", ["codex:old", "codex:1"]]]), sessions);
  assert.deepEqual(order.get("/work/api"), ["codex:old", "codex:1"]);
  assert.deepEqual(order.get("/work/ui"), ["claude:2"]);
  assert.deepEqual(applyOverviewOrder([...sessions].reverse(), order).map((session) => session.id), ["codex:1", "claude:2", "codex:3"]);

  const moved = moveOverviewSession(new Map([["/work/shared", ["codex:1", "hidden", "claude:2"]]]), "/work/shared", "codex:1", "down", ["codex:1", "claude:2"]);
  assert.deepEqual(moved.get("/work/shared"), ["claude:2", "hidden", "codex:1"]);
});

test("overview retains one-tick provider failures and partial snapshots", () => {
  const previous = [
    { id: "claude:sample-app", provider: "claude", cwd: "/work/sample-app" },
    { id: "codex:sample-app", provider: "codex", cwd: "/work/sample-app" },
    { id: "codex:waga", provider: "codex", cwd: "/work/waga" },
  ];
  let missingCounts = new Map();

  let reconciled = reconcileDiscoveredSessions(previous, {
    sessions: [previous[2]],
    warnings: [{ provider: "claude", message: "transient invalid JSON" }],
    availableProviders: ["codex"],
  }, missingCounts);
  assert.deepEqual(reconciled.sessions.map(({ id }) => id), ["codex:waga", "claude:sample-app", "codex:sample-app"]);
  assert.deepEqual([...reconciled.missingCounts], [["codex:sample-app", 1]]);

  missingCounts = reconciled.missingCounts;
  reconciled = reconcileDiscoveredSessions(reconciled.sessions, {
    sessions: previous,
    warnings: [],
    availableProviders: ["claude", "codex"],
  }, missingCounts);
  assert.deepEqual(new Set(reconciled.sessions.map(({ id }) => id)), new Set(previous.map(({ id }) => id)));
  assert.equal(reconciled.missingCounts.size, 0);

  reconciled = reconcileDiscoveredSessions(reconciled.sessions, {
    sessions: [previous[2]], warnings: [], availableProviders: ["claude", "codex"],
  }, reconciled.missingCounts);
  assert.equal(reconciled.sessions.length, 3, "the first healthy omission remains visible");
  reconciled = reconcileDiscoveredSessions(reconciled.sessions, {
    sessions: [previous[2]], warnings: [], availableProviders: ["claude", "codex"],
  }, reconciled.missingCounts);
  assert.deepEqual(reconciled.sessions.map(({ id }) => id), ["codex:waga"], "two consecutive healthy omissions confirm removal");
});

test("overview filtering is provider agnostic and searches names and paths", () => {
  assert.deepEqual(selectOverviewSessions(sessions, { query: "ui" }).map((session) => session.id), ["claude:2"]);
  assert.deepEqual(selectOverviewSessions(sessions, { query: "API 검토" }).map((session) => session.id), ["codex:1"]);
});

test("overview groups sessions into collapsible workspace trees", () => {
  const grouped = [
    { ...sessions[0], cwd: "/work/shared" },
    { ...sessions[1], cwd: "/work/shared" },
    { ...sessions[2], cwd: "/work/other" },
  ];
  const expanded = buildOverviewTree(grouped);
  assert.deepEqual(expanded.map(({ type, key }) => [type, key]), [
    ["workspace", "workspace:/work/shared"],
    ["session", "codex:1"],
    ["session", "claude:2"],
    ["workspace", "workspace:/work/other"],
    ["session", "codex:3"],
  ]);
  const collapsed = buildOverviewTree(grouped, { collapsed: new Set(["/work/shared"]) });
  assert.deepEqual(collapsed.map(({ type, key }) => [type, key]), [
    ["workspace", "workspace:/work/shared"],
    ["workspace", "workspace:/work/other"],
    ["session", "codex:3"],
  ]);
});

test("overview tree includes the launch workspace even when it has no sessions", () => {
  assert.deepEqual(buildOverviewTree([], { rootCwd: "/work/current" }), [{
    type: "workspace",
    key: "workspace:/work/current",
    cwd: "/work/current",
    name: "current",
    sessionCount: 0,
  }]);
});

test("overview groups provider worktrees by their owning project", () => {
  const project = "/work/sample-app";
  const grouped = [
    { ...sessions[0], cwd: project, projectCwd: project },
    { ...sessions[1], cwd: `${project}/.claude/worktrees/issue-1`, projectCwd: project },
  ];
  const nodes = buildOverviewTree(grouped);
  assert.deepEqual(nodes.map(({ type, cwd }) => [type, cwd]), [
    ["workspace", project],
    ["session", project],
    ["session", project],
  ]);
});

test("overview frame renders each workspace once with a tree toggle", () => {
  const grouped = sessions.slice(0, 2).map((session) => ({ ...session, cwd: "/work/shared" }));
  const frame = plain(buildOverviewFrame({ sessions: grouped, selected: 0, width: 100, height: 20, query: "", warnings: [] }));
  assert.equal(frame.match(/\/work\/shared/g)?.length, 1);
  assert.match(frame, /▾\s+shared/);
  assert.match(frame, /\s+CODEX\s+API 검토/);
  assert.match(frame, /\s+CLAUDE\s+UI 구현/);
});

test("native return help follows the tmux mode", () => {
  assert.equal(nativeReturnHint("isolated"), "네이티브 TUI: Alt+G → dock");
  assert.equal(nativeReturnHint("existing"), "네이티브 TUI: tmux prefix + 0 → dock");
});

test("overview frame distinguishes providers and keeps navigation help visible", () => {
  const frame = buildOverviewFrame({ sessions, selected: 1, width: 100, height: 20, query: "", warnings: [] });
  assert.match(frame, /WATTARI GATTARI/);
  assert.match(frame, /CODEX/);
  assert.match(frame, /CLAUDE/);
  assert.match(frame, /Enter 열기/);
  assert.match(frame, /Alt\+N 새 세션/);
  assert.match(frame, /Alt\+R 갱신/);
  assert.match(frame, /F2 이름 변경/);
  assert.match(frame, /Alt\+Q 나가기/);
  assert.match(frame, /Shift\+↑↓ 순서/);
  assert.match(frame, /tmux prefix \+ 0/);
  assert.match(frame, /\x1b\[1;38;2;186;213;232m/);
  assert.doesNotMatch(frame, /\x1b\[38;5;/);
});

test("overview formats and displays cached Codex weekly usage", () => {
  const resetsAt = Math.floor(new Date(2026, 8, 7, 11, 24).getTime() / 1_000);
  const usage = { remainingPercent: 2, windowDurationMins: 10_080, resetsAt };
  assert.equal(formatCodexUsage(usage), "Codex 주간 2% 남음 · 9/7 11:24 초기화");
  const frame = plain(buildOverviewFrame({ sessions, providerUsage: { codex: usage }, width: 120, height: 20 }));
  assert.match(frame, /Codex 주간 2% 남음 · 9\/7 11:24 초기화/);
});

test("overview formats and displays cached Claude usage", () => {
  const resetsAt = Math.floor(new Date(2026, 8, 7, 11, 24).getTime() / 1_000);
  const usage = {
    fiveHour: { remainingPercent: 90 },
    weekly: { remainingPercent: 6, resetsAt },
  };
  assert.equal(formatClaudeUsage(usage), "Claude 5시간 90% · 주간 6% 남음 · 9/7 11:24 초기화");
  const frame = plain(buildOverviewFrame({ sessions, providerUsage: { claude: usage }, width: 120, height: 20 }));
  assert.match(frame, /Claude 5시간 90% · 주간 6% 남음 · 9\/7 11:24 초기화/);
});

test("overview uses native provider colors and colors usage independently", () => {
  const frame = buildOverviewFrame({
    sessions,
    providerUsage: {
      claude: { fiveHour: { remainingPercent: 90 }, weekly: { remainingPercent: 6 } },
      codex: { remainingPercent: 2, windowDurationMins: 10_080 },
    },
    selected: 2,
    width: 120,
    height: 20,
  });

  assert.match(frame, /\x1b\[1;38;2;217;119;87mClaude 5시간 90% · 주간 6% 남음\x1b\[0m/);
  assert.match(frame, /\x1b\[1;36mCodex 주간 2% 남음\x1b\[0m/);
  assert.match(frame, /\x1b\[1;32m●\x1b\[0m.*\x1b\[1;32mworking/);
  assert.match(frame, /\x1b\[1;34m○\x1b\[0m.*\x1b\[1;34mready/);
  assert.match(frame, /\x1b\[1;31m!\x1b\[0m.*\x1b\[1;31mneeds input/);
  assert.doesNotMatch(frame, /38;2;(56;189;248|250;204;21|192;132;252|34;211;238|45;212;191)m/);
});

test("Shift+Up and Shift+Down persist manual order across refreshes", async (t) => {
  const first = [
    { id: "codex:first", provider: "codex", status: "idle", name: "First", cwd: "/work/p", updatedAt: 2 },
    { id: "codex:second", provider: "codex", status: "working", name: "Second", cwd: "/work/p", updatedAt: 1 },
  ];
  const changed = [
    { ...first[1], status: "needs-input", updatedAt: 20 },
    { ...first[0], status: "working", updatedAt: 10 },
  ];
  const input = ttyInput();
  t.after(() => input.emit("end"));
  const output = capturedOutput();
  let discoveries = 0;
  const saves = [];
  const orderStore = {
    load() { return new Map(); },
    saveWorkspace(workspace, ids) { saves.push([workspace, ids]); },
  };
  const bridge = {
    async discover() { return { sessions: discoveries++ === 0 ? first : changed, warnings: [] }; },
  };
  const workspace = {
    async focusOrOpen() {},
    async leave() { return { closeOverview: true }; },
  };
  const running = runOverview({ bridge, workspace, orderStore, defaultCwd: "/work/p", inputStream: input, outputStream: output, refreshMs: 60_000, listenForSignals: false });
  await new Promise((resolve) => setImmediate(resolve));

  input.emit("keypress", "", { name: "down" });
  assert.equal(selectedSessionName(output), "First");
  input.emit("keypress", "", { name: "down", shift: true });
  let frame = plain(output.writes.at(-1));
  assert.ok(frame.indexOf("Second") < frame.indexOf("First"));
  assert.equal(selectedSessionName(output), "First");
  assert.deepEqual(saves, [["/work/p", ["codex:second", "codex:first"]]]);

  pressAlt(input, "r");
  await waitFor(() => discoveries === 2);
  frame = plain(output.writes.at(-1));
  assert.ok(frame.indexOf("Second") < frame.indexOf("First"));

  pressAlt(input, "q");
  assert.equal(await running, 0);
});

test("overview frame switches to a compact layout when the terminal narrows", () => {
  const frame = buildOverviewFrame({ sessions, selected: 1, width: 40, height: 14, query: "API", warnings: [] });
  assert.match(frame, /WAGA/);
  assert.match(frame, /CLAUDE/);
  assert.match(frame, /검색/);
  assert.doesNotMatch(frame, /\/work\/ui/);
});

test("empty overview points to the Alt refresh command", () => {
  const frame = plain(buildOverviewFrame({ sessions: [], width: 100, height: 20 }));
  assert.match(frame, /Alt\+R을 눌러 새로고침하세요/);
  assert.doesNotMatch(frame, /(^|\s)r을 눌러/);
});

test("Escape cancels the composer without the readline default delay", async () => {
  const input = rawTtyInput();
  const output = capturedOutput();
  const bridge = { async discover() { return { sessions: [{ ...sessions[0], cwd: "/work/current" }], warnings: [] }; } };
  const workspace = {
    async focusOrOpen() {},
    async leave() { return { closeOverview: true }; },
  };
  const running = runOverview({ bridge, workspace, defaultCwd: "/work/current", inputStream: input, outputStream: output, refreshMs: 60_000, listenForSignals: false });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(plain(output.writes.at(-1)), /current/);
    input.write("\u001bn");
    await waitFor(() => /새 세션 생성/.test(plain(output.writes.at(-1))));
    const started = performance.now();
    input.write("\u001b");
    await waitFor(() => !/새 세션 생성/.test(plain(output.writes.at(-1))));
    assert.ok(performance.now() - started < 200);
    input.write("\u001b[B");
    await waitFor(() => selectedSessionName(output) === "API");
  } finally {
    input.end();
    await running;
  }
});

test("Alt+Q leaves the dock", async () => {
  const input = rawTtyInput();
  const output = capturedOutput();
  let leaves = 0;
  const bridge = { async discover() { return { sessions: [], warnings: [] }; } };
  const workspace = {
    async focusOrOpen() {},
    async leave() { leaves += 1; return { closeOverview: true }; },
  };
  const running = runOverview({ bridge, workspace, inputStream: input, outputStream: output, refreshMs: 60_000, listenForSignals: false });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    input.write("\u001bq");
    await waitFor(() => leaves === 1);
    assert.equal(await running, 0);
  } finally {
    input.end();
    await running;
  }
});

test("Alt+X twice archives the selected session and closes its retained view", async (t) => {
  const input = ttyInput();
  t.after(() => input.emit("end"));
  const output = capturedOutput();
  const active = { id: "codex:archive-me", nativeId: "archive-me", provider: "codex", status: "idle", name: "Archive me", cwd: "/work/p", updatedAt: 1 };
  let archived = false;
  const archiveCalls = [];
  const closedViews = [];
  const bridge = {
    async discover() { return { sessions: archived ? [] : [active], warnings: [] }; },
    async archive(target, options) { archiveCalls.push([target, options]); archived = true; return { target, archived: true }; },
  };
  const workspace = {
    async focusOrOpen() {},
    async closeSessionView(session) { closedViews.push(session.id); return { closed: true }; },
    async leave() { return { closeOverview: true }; },
  };
  const running = runOverview({ bridge, workspace, defaultCwd: "/work/p", inputStream: input, outputStream: output, refreshMs: 60_000, listenForSignals: false });
  await new Promise((resolve) => setImmediate(resolve));
  input.emit("keypress", "", { name: "down" });

  input.emit("keypress", "", { name: "x", meta: true });
  assert.equal(archiveCalls.length, 0);
  assert.match(plain(output.writes.at(-1)), /Alt\+X를 다시 누르면/);

  input.emit("keypress", "", { name: "x", meta: true });
  await waitFor(() => archiveCalls.length === 1 && closedViews.length === 1);
  assert.deepEqual(archiveCalls, [["codex:archive-me", {}]]);
  assert.deepEqual(closedViews, ["codex:archive-me"]);
  await waitFor(() => /0 need input\s+0 working\s+0 ready/.test(plain(output.writes.at(-1))));

  pressAlt(input, "q");
  assert.equal(await running, 0);
});

for (const slowStage of ["close", "refresh"]) test(`Alt+X removes the row and unlocks input before ${slowStage} finishes`, async (t) => {
  const input = ttyInput(), output = capturedOutput();
  let release; const pending = new Promise((resolve) => { release = resolve; });
  const active = { ...sessions[0], name: "archive-proof" };
  const remaining = { ...active, id: "codex:remaining", name: "remaining-proof" };
  let archived = false, reads = 0, closeCalls = 0;
  const snapshot = { sessions: [active, remaining], warnings: [] };
  t.after(() => release(snapshot));
  const bridge = {
    async discover() { reads++; return archived && slowStage === "refresh" ? pending : snapshot; },
    async archive() { archived = true; },
  };
  const workspace = {
    async closeSessionView() { closeCalls++; if (slowStage === "close") await pending; },
  };
  const running = runOverview({ bridge, workspace, defaultCwd: active.cwd, inputStream: input, outputStream: output, refreshMs: 60_000, listenForSignals: false });
  await new Promise(setImmediate);
  input.emit("keypress", "", { name: "down" });
  pressAlt(input, "x"); pressAlt(input, "x");
  await new Promise(setImmediate);
  assert.equal(archived, true);
  assert.equal(closeCalls, 1);
  assert.equal(reads, slowStage === "close" ? 1 : 2);
  assert.doesNotMatch(plain(output.writes.at(-1)), /CODEX\s+archive-proof/, "confirmed archive must disappear before background work finishes");
  assert.equal(selectedSessionName(output), remaining.name);
  pressAlt(input, "n");
  input.emit("keypress", "keep draft", { sequence: "keep draft" });
  assert.match(plain(output.writes.at(-1)), /새 세션 생성/);
  release(snapshot); // A stale provider snapshot must not resurrect the archived row.
  await new Promise(setImmediate);
  assert.match(plain(output.writes.at(-1)), /keep draft/);
  assert.doesNotMatch(plain(output.writes.at(-1)), /CODEX\s+archive-proof/);
  input.emit("end"); await running;
});

test("Alt+X waits for native acknowledgement and ignores repeated confirmation while pending", async (t) => {
  const input = ttyInput(), output = capturedOutput();
  let release; const pending = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  let calls = 0, closes = 0;
  const bridge = {
    async discover() { return { sessions: [sessions[0]], warnings: [] }; },
    async archive() { calls++; await pending; },
  };
  const running = runOverview({ bridge, workspace: { async closeSessionView() { closes++; } }, defaultCwd: sessions[0].cwd,
    inputStream: input, outputStream: output, refreshMs: 60_000, listenForSignals: false });
  await new Promise(setImmediate);
  input.emit("keypress", "", { name: "down" });
  pressAlt(input, "x"); pressAlt(input, "x"); pressAlt(input, "x");
  await new Promise(setImmediate);
  assert.equal(calls, 1); assert.equal(closes, 0);
  assert.equal(selectedSessionName(output), "API");
  release(); await new Promise(setImmediate);
  assert.equal(closes, 1);
  assert.doesNotMatch(plain(output.writes.at(-1)), /CODEX\s+API/);
  input.emit("end"); await running;
});

test("late Alt+X view cleanup failure stays a warning without restoring the row or replacing a draft", async (t) => {
  const input = ttyInput(), output = capturedOutput();
  let reject; const pending = new Promise((_, fail) => { reject = fail; });
  t.after(() => reject(new Error("cleanup failed")));
  const bridge = {
    async discover() { return { sessions: [sessions[0]], warnings: [] }; },
    async archive() {},
  };
  const running = runOverview({ bridge, workspace: { closeSessionView: () => pending }, defaultCwd: sessions[0].cwd,
    inputStream: input, outputStream: output, refreshMs: 60_000, listenForSignals: false });
  await new Promise(setImmediate);
  input.emit("keypress", "", { name: "down" });
  pressAlt(input, "x"); pressAlt(input, "x"); await new Promise(setImmediate);
  pressAlt(input, "n"); input.emit("keypress", "new draft", { sequence: "new draft" });
  reject(new Error("cleanup failed")); await new Promise(setImmediate);
  assert.match(plain(output.writes.at(-1)), /new draft/);
  input.emit("keypress", "", { name: "escape" });
  assert.match(plain(output.writes.at(-1)), /보관된 세션 창을 닫지 못했습니다: cleanup failed/);
  assert.doesNotMatch(plain(output.writes.at(-1)), /CODEX\s+API/);
  input.emit("end"); await running;
});

test("Alt+X background cleanup cannot unlock or refresh over a newer pending creation", async (t) => {
  const input = ttyInput(), output = capturedOutput();
  let finishClose, finishCreate;
  const closing = new Promise((resolve) => { finishClose = resolve; });
  const creating = new Promise((resolve) => { finishCreate = resolve; });
  t.after(() => { finishClose(); finishCreate({ provider: "claude", nativeId: "1234abcd" }); });
  let reads = 0, creates = 0;
  const bridge = {
    async discover() { reads++; return { sessions: [sessions[0]], warnings: [] }; },
    async archive() {},
    async create() { creates++; return creating; },
  };
  const running = runOverview({ bridge, workspace: { closeSessionView: () => closing }, defaultCwd: sessions[0].cwd,
    inputStream: input, outputStream: output, refreshMs: 60_000, listenForSignals: false });
  await new Promise(setImmediate);
  input.emit("keypress", "", { name: "down" });
  pressAlt(input, "x"); pressAlt(input, "x"); await new Promise(setImmediate);
  pressAlt(input, "n"); input.emit("keypress", "next work", { sequence: "next work" });
  input.emit("keypress", "", { name: "return" });
  await new Promise(setImmediate);
  assert.equal(creates, 1);
  finishClose(); await new Promise(setImmediate);
  assert.equal(reads, 1, "cleanup must defer discovery while another foreground action is busy");
  input.emit("keypress", "", { name: "return" });
  assert.equal(creates, 1, "a late cleanup must not unlock a newer creation and submit it twice");
  assert.match(plain(output.writes.at(-1)), /생성 중/);
  finishCreate({ provider: "claude", nativeId: "1234abcd" }); await new Promise(setImmediate);
  assert.equal(reads, 2);
  input.emit("end"); await running;
});

for (const slowStage of ["native", "close"]) test(`late Alt+X ${slowStage} completion does not touch a closed dock`, async (t) => {
  const input = ttyInput(), output = capturedOutput();
  let release; const pending = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  let reads = 0, closes = 0;
  const bridge = {
    async discover() { reads++; return { sessions: [sessions[0]], warnings: [] }; },
    async archive() { if (slowStage === "native") await pending; },
  };
  const running = runOverview({ bridge, workspace: { async closeSessionView() { closes++; await pending; } }, defaultCwd: sessions[0].cwd,
    inputStream: input, outputStream: output, refreshMs: 60_000, listenForSignals: false });
  await new Promise(setImmediate);
  input.emit("keypress", "", { name: "down" });
  pressAlt(input, "x"); pressAlt(input, "x"); await new Promise(setImmediate);
  input.emit("end"); await running;
  const writes = output.writes.length;
  release(); await new Promise(setImmediate);
  assert.equal(output.writes.length, writes);
  assert.equal(reads, 1);
  assert.equal(closes, slowStage === "native" ? 0 : 1);
});

test("failed Alt+X archive keeps the session and its retained view", async (t) => {
  const input = ttyInput();
  t.after(() => input.emit("end"));
  const output = capturedOutput();
  const active = { id: "claude:keep-me", nativeId: "keep-me", provider: "claude", status: "idle", name: "Keep me", cwd: "/work/p", updatedAt: 1 };
  let closeCalls = 0;
  const bridge = {
    async discover() { return { sessions: [active], warnings: [] }; },
    async archive() { throw new Error("provider refused archive"); },
  };
  const workspace = {
    async focusOrOpen() {},
    async closeSessionView() { closeCalls += 1; },
    async leave() { return { closeOverview: true }; },
  };
  const running = runOverview({ bridge, workspace, defaultCwd: "/work/p", inputStream: input, outputStream: output, refreshMs: 60_000, listenForSignals: false });
  await new Promise((resolve) => setImmediate(resolve));
  input.emit("keypress", "", { name: "down" });

  input.emit("keypress", "", { name: "x", meta: true });
  input.emit("keypress", "", { name: "x", meta: true });
  await waitFor(() => /provider refused archive/.test(plain(output.writes.at(-1))));
  assert.equal(closeCalls, 0);
  assert.match(plain(output.writes.at(-1)), /Keep me/);

  pressAlt(input, "q");
  assert.equal(await running, 0);
});

test("Enter collapses and expands a workspace without opening a native session", async () => {
  const input = ttyInput();
  const output = capturedOutput();
  let nativeOpens = 0;
  const bridge = {
    async discover() { return { sessions: [sessions[0]], warnings: [] }; },
  };
  const workspace = {
    async focusOrOpen() { nativeOpens += 1; },
    async leave() { return { closeOverview: true }; },
  };
  const running = runOverview({ bridge, workspace, defaultCwd: "/work/api", inputStream: input, outputStream: output, refreshMs: 60_000, listenForSignals: false });
  await new Promise((resolve) => setImmediate(resolve));

  input.emit("keypress", "", { name: "return" });
  assert.match(plain(output.writes.at(-1)), /›\s+▸\s+api/);
  assert.doesNotMatch(plain(output.writes.at(-1)), /CODEX/);
  input.emit("keypress", "", { name: "return" });
  assert.match(plain(output.writes.at(-1)), /›\s+▾\s+api/);
  assert.match(plain(output.writes.at(-1)), /CODEX/);
  assert.equal(nativeOpens, 0);

  pressAlt(input, "q");
  assert.equal(await running, 0);
});

test("Alt+Enter forces an exact native session reattach", async () => {
  const input = ttyInput();
  const output = capturedOutput();
  const calls = [];
  const bridge = { async discover() { return { sessions: [sessions[0]], warnings: [] }; } };
  const workspace = {
    async focusOrOpen(...args) { calls.push(args); },
    async leave() { return { closeOverview: true }; },
  };
  const running = runOverview({
    bridge,
    workspace,
    defaultCwd: "/work/api",
    commandFor: async () => ({ command: "codex", args: ["resume", "codex:1"], cwd: "/work/api" }),
    inputStream: input,
    outputStream: output,
    refreshMs: 60_000,
    listenForSignals: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  input.emit("keypress", "", { name: "down" });

  input.emit("keypress", "", { name: "return", meta: true });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls[0][2], { force: true, knownNativeIds: [sessions[0].nativeId] });
  pressAlt(input, "q");
  assert.equal(await running, 0);
});

test("overview discovery is global unless a cwd filter is explicit", async () => {
  for (const [filterCwd, expected] of [[null, { includeUsage: true }], ["/tmp/project", { cwd: "/tmp/project", includeUsage: true }]]) {
    const input = Object.assign(new EventEmitter(), {
      isTTY: true,
      setRawMode() {},
      resume() {},
    });
    const output = Object.assign(new EventEmitter(), {
      isTTY: true,
      columns: 80,
      rows: 20,
      write() {},
    });
    let discoveredWith;
    const bridge = {
      async discover(options) {
        discoveredWith = options;
        queueMicrotask(() => input.emit("end"));
        return { sessions: [], warnings: [] };
      },
    };
    assert.equal(await runOverview({ filterCwd, bridge, inputStream: input, outputStream: output, listenForSignals: false }), 0);
    assert.deepEqual(discoveredWith, expected);
  }
});

test("overview pauses discovery while a direct native TUI owns the terminal", async () => {
  const input = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode() {},
    resume() {},
  });
  const output = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 80,
    rows: 20,
    write() {},
  });
  let discoveries = 0;
  let releaseNative;
  const nativeClosed = new Promise((resolve) => { releaseNative = resolve; });
  const bridge = {
    async discover() {
      discoveries += 1;
      return { sessions: [sessions[0]], warnings: [] };
    },
  };
  const workspace = {
    async focusOrOpen() { return nativeClosed; },
    async leave() { return { closeOverview: true }; },
  };

  const running = runOverview({
    bridge,
    workspace,
    defaultCwd: "/work/api",
    commandFor: async () => ({ command: "provider", args: [], cwd: "/tmp" }),
    inputStream: input,
    outputStream: output,
    refreshMs: 5,
    listenForSignals: false,
  });
  await new Promise((resolve) => setImmediate(resolve));
  input.emit("keypress", "", { name: "down" });
  input.emit("keypress", "", { name: "return" });
  const discoveriesWhenOpened = discoveries;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const discoveriesWhileBusy = discoveries;

  releaseNative({ code: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  pressAlt(input, "q");
  assert.equal(await running, 0);
  assert.equal(discoveriesWhileBusy, discoveriesWhenOpened);
});

test("overview stops provider polling while its tmux window is hidden", async () => {
  const input = ttyInput();
  const output = capturedOutput();
  let visible = false;
  let discoveries = 0;
  const bridge = {
    async discover() {
      discoveries += 1;
      return { sessions: [], warnings: [], availableProviders: ["claude", "codex"] };
    },
  };
  const workspace = {
    async shouldRefreshOverview() { return visible; },
    async reconcileSessionViews() {},
    async focusOrOpen() {},
    async leave() { return { closeOverview: true }; },
  };

  const running = runOverview({ bridge, workspace, inputStream: input, outputStream: output, refreshMs: 5, listenForSignals: false });
  await waitFor(() => discoveries === 1);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(discoveries, 1, "only the forced initial discovery may run while hidden");

  visible = true;
  await waitFor(() => discoveries >= 2);
  pressAlt(input, "q");
  assert.equal(await running, 0);
});

test("overview does not blink a workspace out on a transient mixed-provider snapshot", async () => {
  const input = ttyInput();
  const output = capturedOutput();
  const sampleAppClaude = { id: "claude:sample-app", provider: "claude", status: "idle", name: "Sample App Claude", cwd: "/work/sample-app" };
  const sampleAppCodex = { id: "codex:sample-app", provider: "codex", status: "working", name: "Sample App Codex", cwd: "/work/sample-app" };
  const wagaCodex = { id: "codex:waga", provider: "codex", status: "working", name: "Waga Codex", cwd: "/work/waga" };
  const snapshots = [
    { sessions: [sampleAppClaude, sampleAppCodex, wagaCodex], warnings: [], availableProviders: ["claude", "codex"] },
    { sessions: [wagaCodex], warnings: [{ provider: "claude", message: "transient invalid JSON" }], availableProviders: ["codex"] },
    { sessions: [sampleAppClaude, sampleAppCodex, wagaCodex], warnings: [], availableProviders: ["claude", "codex"] },
  ];
  let discoveries = 0;
  const bridge = {
    async discover() {
      const snapshot = snapshots[Math.min(discoveries, snapshots.length - 1)];
      discoveries += 1;
      return snapshot;
    },
  };
  const workspace = {
    async shouldRefreshOverview() { return true; },
    async reconcileSessionViews() {},
    async leave() { return { closeOverview: true }; },
  };

  const running = runOverview({ bridge, workspace, inputStream: input, outputStream: output, refreshMs: 60_000, listenForSignals: false });
  await waitFor(() => discoveries === 1 && plain(output.writes.at(-1)).includes("Sample App Codex"));
  pressAlt(input, "r");
  await waitFor(() => discoveries === 2 && plain(output.writes.at(-1)).includes("transient invalid JSON"));
  assert.match(plain(output.writes.at(-1)), /sample-app \/work\/sample-app · 2 sessions/);
  assert.match(plain(output.writes.at(-1)), /Sample App Claude/);
  assert.match(plain(output.writes.at(-1)), /Sample App Codex/);

  pressAlt(input, "r");
  await waitFor(() => discoveries === 3 && !plain(output.writes.at(-1)).includes("transient invalid JSON"));
  assert.match(plain(output.writes.at(-1)), /sample-app \/work\/sample-app · 2 sessions/);
  pressAlt(input, "q");
  assert.equal(await running, 0);
});

test("overview reconciles retained tmux views with healthy provider results", async (t) => {
  const input = ttyInput();
  t.after(() => input.emit("end"));
  const output = capturedOutput();
  const reconciled = [];
  const bridge = {
    async discover() {
      return {
        sessions: [sessions[0]],
        warnings: [{ provider: "codex-secondary", message: "offline" }],
        availableProviders: ["claude", "codex"],
      };
    },
  };
  const workspace = {
    async reconcileSessionViews(active, options) { reconciled.push([active, options]); },
    async focusOrOpen() {},
    async leave() { return { closeOverview: true }; },
  };

  const running = runOverview({ bridge, workspace, inputStream: input, outputStream: output, refreshMs: 60_000, listenForSignals: false });
  await waitFor(() => reconciled.length === 1);
  assert.deepEqual(reconciled[0], [[sessions[0]], { availableProviders: ["claude", "codex"] }]);
  pressAlt(input, "q");
  assert.equal(await running, 0);
});

test("overview keeps newer keyboard selection when an older refresh completes", async () => {
  const stable = [
    { id: "codex:a", provider: "codex", status: "idle", name: "A", cwd: "/work/p", updatedAt: 3 },
    { id: "codex:b", provider: "codex", status: "idle", name: "B", cwd: "/work/p", updatedAt: 2 },
    { id: "codex:c", provider: "codex", status: "idle", name: "C", cwd: "/work/p", updatedAt: 1 },
  ];
  const input = ttyInput();
  const output = capturedOutput();
  let calls = 0;
  let releaseRefresh;
  let markRefreshStarted;
  const refreshStarted = new Promise((resolve) => { markRefreshStarted = resolve; });
  const bridge = {
    async discover() {
      calls += 1;
      if (calls === 1) return { sessions: stable, warnings: [] };
      if (calls === 2) {
        markRefreshStarted();
        return await new Promise((resolve) => { releaseRefresh = resolve; });
      }
      return { sessions: stable, warnings: [] };
    },
  };
  const workspace = {
    async focusOrOpen() {},
    async leave() { return { closeOverview: true }; },
  };

  const running = runOverview({ bridge, workspace, defaultCwd: "/work/p", inputStream: input, outputStream: output, refreshMs: 5, listenForSignals: false });
  await refreshStarted;
  input.emit("keypress", "", { name: "down" });
  input.emit("keypress", "", { name: "down" });
  input.emit("keypress", "", { name: "down" });
  assert.equal(selectedSessionName(output), "C");

  releaseRefresh({ sessions: stable, warnings: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(selectedSessionName(output), "C");

  pressAlt(input, "q");
  assert.equal(await running, 0);
});

test("overview navigation stops at tree boundaries instead of wrapping", async () => {
  const stable = [
    { id: "codex:a", provider: "codex", status: "idle", name: "A", cwd: "/work/p", updatedAt: 2 },
    { id: "codex:b", provider: "codex", status: "idle", name: "B", cwd: "/work/p", updatedAt: 1 },
  ];
  const input = ttyInput();
  const output = capturedOutput();
  const bridge = {
    async discover() { return { sessions: stable, warnings: [] }; },
  };
  const workspace = {
    async focusOrOpen() {},
    async leave() { return { closeOverview: true }; },
  };
  const running = runOverview({ bridge, workspace, defaultCwd: "/work/p", inputStream: input, outputStream: output, refreshMs: 60_000, listenForSignals: false });
  await new Promise((resolve) => setImmediate(resolve));

  input.emit("keypress", "", { name: "up" });
  assert.match(plain(output.writes.at(-1)), /›\s+▾\s+p/);
  input.emit("keypress", "", { name: "down" });
  input.emit("keypress", "", { name: "down" });
  input.emit("keypress", "", { name: "down" });
  assert.equal(selectedSessionName(output), "B");

  pressAlt(input, "q");
  assert.equal(await running, 0);
});

test("provider tabs clear stale rows and select the first matching session", async () => {
  const input = ttyInput();
  const output = capturedOutput();
  const bridge = {
    async discover() { return { sessions, warnings: [] }; },
  };
  const workspace = {
    async focusOrOpen() {},
    async leave() { return { closeOverview: true }; },
  };
  const running = runOverview({ bridge, workspace, defaultCwd: "/work/p", inputStream: input, outputStream: output, refreshMs: 60_000, listenForSignals: false });
  await new Promise((resolve) => setImmediate(resolve));

  input.emit("keypress", "", { name: "tab" });
  const claudeFrame = output.writes.at(-1);
  assert.match(claudeFrame, /^\x1b\[H\x1b\[J/);
  assert.doesNotMatch(plain(claudeFrame), /CODEX/);
  assert.equal(selectedSessionName(output), "UI");

  input.emit("keypress", "", { name: "tab" });
  const codexFrame = output.writes.at(-1);
  assert.match(codexFrame, /^\x1b\[H\x1b\[J/);
  assert.doesNotMatch(plain(codexFrame), /CLAUDE/);
  assert.equal(selectedSessionName(output), "API");

  pressAlt(input, "q");
  assert.equal(await running, 0);
});

test("overview uses Alt shortcuts consistently for commands", async (t) => {
  const stable = [
    { id: "codex:a", provider: "codex", status: "idle", name: "A", cwd: "/work/p", updatedAt: 2 },
    { id: "codex:b", provider: "codex", status: "idle", name: "B", cwd: "/work/p", updatedAt: 1 },
  ];
  const input = ttyInput();
  t.after(() => input.emit("end"));
  const output = capturedOutput();
  let discoveries = 0;
  let leaves = 0;
  const bridge = {
    async discover() {
      discoveries += 1;
      return { sessions: stable, warnings: [] };
    },
  };
  const workspace = {
    async focusOrOpen() {},
    async leave() {
      leaves += 1;
      return { closeOverview: true };
    },
  };
  const running = runOverview({ bridge, workspace, defaultCwd: "/work/p", inputStream: input, outputStream: output, refreshMs: 60_000, listenForSignals: false });
  await new Promise((resolve) => setImmediate(resolve));

  input.emit("keypress", "j", { name: "j", sequence: "j" });
  input.emit("keypress", "ㅓ", { sequence: "ㅓ" });
  assert.match(plain(output.writes.at(-1)), /›\s+▾\s+p/);
  const discoveriesBeforeRefresh = discoveries;
  input.emit("keypress", "r", { name: "r", sequence: "r" });
  input.emit("keypress", "ㄱ", { sequence: "ㄱ" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(discoveries, discoveriesBeforeRefresh);
  input.emit("keypress", "q", { name: "q", sequence: "q" });
  input.emit("keypress", "ㅂ", { sequence: "ㅂ" });
  assert.equal(leaves, 0);

  input.emit("keypress", "\u0012", { name: "r", sequence: "\u0012", ctrl: true });
  input.emit("keypress", "\u0011", { name: "q", sequence: "\u0011", ctrl: true });
  input.emit("keypress", "\u000e", { name: "n", sequence: "\u000e", ctrl: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(discoveries, discoveriesBeforeRefresh);
  assert.equal(leaves, 0);
  assert.doesNotMatch(plain(output.writes.at(-1)), /새 세션 생성/);

  pressAlt(input, "r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(discoveries, discoveriesBeforeRefresh + 1);
  pressAlt(input, "q");
  assert.equal(await running, 0);
  assert.equal(leaves, 1);
});

test("created session is visible and input unlocks before an unrelated full refresh finishes", async (t) => {
  const input = ttyInput(), output = capturedOutput();
  let release; const pending = new Promise((resolve) => { release = resolve; });
  t.after(() => release({ sessions: [], warnings: [], availableProviders: ["claude", "codex"] }));
  const session = { id: "claude:full-new", nativeId: "1234abcd", provider: "claude", status: "working", name: "new-proof", cwd: "/work/new" };
  let reads = 0;
  const bridge = {
    async discover() { return ++reads === 1 ? { sessions: [], warnings: [] } : pending; },
    async create() { return { provider: "claude", nativeId: session.nativeId, session }; },
  };
  const running = runOverview({ bridge, workspace: {}, defaultCwd: session.cwd, inputStream: input, outputStream: output, refreshMs: 60_000, listenForSignals: false });
  await new Promise(setImmediate);
  pressAlt(input, "n"); input.emit("keypress", "proof", { sequence: "proof" }); input.emit("keypress", "", { name: "return" });
  await new Promise(setImmediate);
  assert.equal(selectedSessionName(output), session.name);
  pressAlt(input, "n");
  assert.match(plain(output.writes.at(-1)), /새 세션 생성/, "input must not wait for full discovery");
  input.emit("keypress", "", { name: "escape" });
  release({ sessions: [], warnings: [], availableProviders: ["claude", "codex"] });
  await new Promise(setImmediate);
  assert.match(plain(output.writes.at(-1)), /new-proof/, "one temporarily missing snapshot must preserve the new session");
  input.emit("end"); await running;
});

for (const metadata of [true, false]) test(`creation survives an older in-flight refresh without stealing later selection (metadata=${metadata})`, async (t) => {
  const input = ttyInput(), output = capturedOutput();
  let release; const stale = new Promise((resolve) => { release = resolve; });
  t.after(() => release({ sessions: [], warnings: [] }));
  const session = { id: "claude:new-id", nativeId: "1234abcd", provider: "claude", name: "created-proof", status: "working", cwd: "/work/new" };
  let reads = 0;
  const bridge = {
    async discover() { if (++reads === 2) return stale; return { sessions: reads > 2 ? [session] : [], warnings: [] }; },
    async create() { return { provider: "claude", nativeId: session.nativeId, ...(metadata ? { session } : {}) }; },
  };
  const running = runOverview({ bridge, workspace: {}, defaultCwd: session.cwd, inputStream: input, outputStream: output, refreshMs: 60_000, listenForSignals: false });
  await new Promise(setImmediate);
  pressAlt(input, "r"); await new Promise(setImmediate);
  pressAlt(input, "n"); input.emit("keypress", "proof", { sequence: "proof" }); input.emit("keypress", "", { name: "return" });
  await new Promise(setImmediate);
  input.emit("keypress", "", { name: "up" }); // Deliberately select the workspace, not the pending session.
  release({ sessions: [], warnings: [] }); await new Promise(setImmediate);
  assert.equal(reads, 3, "the invalidated snapshot must trigger one replacement refresh");
  assert.match(plain(output.writes.at(-1)), /created-proof/);
  assert.equal(selectedSessionName(output), null, "late creation lookup must respect subsequent navigation");
  assert.equal((plain(output.writes.at(-1)).match(/created-proof/g) ?? []).length, 1);
  input.emit("end"); await running;
});

test("late creation completion cannot repaint a closed overview", async () => {
  const input = ttyInput(), output = capturedOutput();
  let release; const pending = new Promise((resolve) => { release = resolve; });
  let reads = 0;
  const running = runOverview({ bridge: { async discover() { reads++; return { sessions: [], warnings: [] }; }, create: () => pending },
    workspace: {}, defaultCwd: "/work/new", inputStream: input, outputStream: output, refreshMs: 60_000, listenForSignals: false });
  await new Promise(setImmediate);
  pressAlt(input, "n"); input.emit("keypress", "proof", { sequence: "proof" }); input.emit("keypress", "", { name: "return" });
  input.emit("end"); await running;
  const writes = output.writes.length;
  release({ provider: "claude", nativeId: "1234abcd" }); await new Promise(setImmediate);
  assert.equal(output.writes.length, writes); assert.equal(reads, 1);
});

test("overview creates a provider-owned session from its one-line composer", async (t) => {
  const input = ttyInput();
  t.after(() => input.emit("end"));
  const output = capturedOutput();
  let created = null;
  let resolveCreate;
  const createCalled = new Promise((resolve) => { resolveCreate = resolve; });
  let discovered = [];
  const bridge = {
    async discover() { return { sessions: discovered, warnings: [] }; },
    async create(provider, prompt, options) {
      created = { provider, prompt, options };
      discovered = [{ id: "codex:thread-new", nativeId: "thread-new", provider: "codex", status: "working", name: prompt, cwd: options.cwd, updatedAt: 1 }];
      resolveCreate();
      return { provider, nativeId: "thread-new" };
    },
  };
  const workspace = {
    async focusOrOpen() {},
    async leave() { return { closeOverview: true }; },
  };
  const running = runOverview({ bridge, workspace, defaultCwd: "/work/new", inputStream: input, outputStream: output, refreshMs: 60_000, listenForSignals: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(plain(output.writes.at(-1)), /▾\s+new.*0 sessions/);

  input.emit("keypress", "n", { name: "n", sequence: "n" });
  assert.doesNotMatch(plain(output.writes.at(-1)), /새 세션 생성/);
  pressAlt(input, "n");
  assert.match(plain(output.writes.at(-1)), /새 세션 생성\s+◆\s+CLAUDE\s+◆\s+\/work\/new/);
  assert.match(plain(output.writes.at(-1)), /Tab → CODEX 전환/);
  assert.match(output.writes.at(-1), /\x1b\[1;38;2;217;119;87m◆  CLAUDE  ◆/);
  input.emit("keypress", "", { name: "tab" });
  assert.match(plain(output.writes.at(-1)), /새 세션 생성\s+■\s+CODEX\s+■\s+\/work\/new/);
  assert.match(plain(output.writes.at(-1)), /Tab → CLAUDE 전환/);
  assert.match(output.writes.at(-1), /\x1b\[1;36m■  CODEX  ■/);
  input.emit("keypress", "작업", { sequence: "작업" });
  input.emit("keypress", "", { name: "left" });
  input.emit("keypress", "새", { sequence: "새" });
  assert.match(plain(output.writes.at(-1)), /› 작새업/);
  input.emit("keypress", "", { name: "return" });
  await createCalled;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(created.provider, "codex");
  assert.equal(created.prompt, "작새업");
  assert.equal(created.options.cwd, "/work/new");
  assert.deepEqual({ model: created.options.routing.model, effort: created.options.routing.effort, tier: created.options.routing.tier }, {
    model: "gpt-5.6-luna",
    effort: "max",
    tier: "default",
  });
  assert.equal(selectedSessionName(output), "작새업");
  pressAlt(input, "q");
  assert.equal(await running, 0);
});

test("overview previews automatic routing for a skill-based task", async (t) => {
  const input = ttyInput();
  t.after(() => input.emit("end"));
  const output = capturedOutput();
  let created;
  const bridge = {
    async discover() { return { sessions: [], warnings: [] }; },
    async create(provider, prompt, options) {
      created = { provider, prompt, options };
      return { provider, nativeId: "thread-routed" };
    },
  };
  const workspace = { async leave() { return { closeOverview: true }; } };
  const running = runOverview({ bridge, workspace, defaultCwd: "/work/sample-app", inputStream: input, outputStream: output, refreshMs: 60_000, listenForSignals: false });
  await new Promise((resolve) => setImmediate(resolve));
  input.emit("keypress", "", { name: "tab" });
  input.emit("keypress", "", { name: "tab" });
  pressAlt(input, "n");
  input.emit("keypress", "이슈루프 스킬써서 #123번 이슈 확인해봐", { sequence: "이슈루프 스킬써서 #123번 이슈 확인해봐" });
  assert.match(plain(output.writes.at(-1)), /자동 라우팅: GPT-6 Astra · low/);
  assert.match(plain(output.writes.at(-1)), /issue-loop/);
  input.emit("keypress", "", { name: "return" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(created.options.routing.model, "gpt-6-astra");
  assert.equal(created.options.routing.effort, "low");
  assert.deepEqual(created.options.routing.skills, ["issue-loop"]);
  input.emit("end");
  assert.equal(await running, 0);
});

for (const nameSync of [undefined, "pending", "local"]) test(`F2 renames the selected session and explains ${nameSync ?? "native"} sync`, async (t) => {
  const input = ttyInput();
  t.after(() => input.emit("end"));
  const output = capturedOutput();
  let discovered = [{ id: "claude:full-id", nativeId: "1234abcd", provider: "claude", status: "idle", name: "before", cwd: "/work/new", updatedAt: 1 }];
  let renamed = null;
  let resolveRename;
  const renameCalled = new Promise((resolve) => { resolveRename = resolve; });
  const bridge = {
    async discover() { return { sessions: discovered, warnings: [] }; },
    async rename(target, name, options) {
      renamed = { target, name, options };
      discovered = discovered.map((session) => session.id === target ? { ...session, name } : session);
      resolveRename();
      return { target, renamed: true, name, nameSync };
    },
  };
  const workspace = {
    async focusOrOpen() {},
    async leave() { return { closeOverview: true }; },
  };
  const running = runOverview({ bridge, workspace, defaultCwd: "/work/new", inputStream: input, outputStream: output, refreshMs: 60_000, listenForSignals: false });
  await new Promise((resolve) => setImmediate(resolve));

  input.emit("keypress", "", { name: "down" });
  input.emit("keypress", "", { name: "f2" });
  assert.match(plain(output.writes.at(-1)), /세션 이름 변경\s+◆\s+CLAUDE\s+◆/);
  assert.match(plain(output.writes.at(-1)), /현재: before/);
  input.emit("keypress", "검토 세션", { sequence: "검토 세션" });
  input.emit("keypress", "", { name: "return" });
  await renameCalled;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(renamed, { target: "claude:full-id", name: "검토 세션", options: {} });
  assert.equal(selectedSessionName(output), "검토");
  assert.match(plain(output.writes.at(-1)), /이름을 '검토 세션'\(으\)로 변경했습니다/);
  if (nameSync === "pending") assert.match(plain(output.writes.at(-1)), /다음 프롬프트/);
  if (nameSync === "local") assert.match(plain(output.writes.at(-1)), /로컬 이름만/);
  pressAlt(input, "q");
  assert.equal(await running, 0);
});

test("new-session composer keeps a failed prompt editable and Escape cancels it", async (t) => {
  const input = ttyInput();
  t.after(() => input.emit("end"));
  const output = capturedOutput();
  let creates = 0;
  const bridge = {
    async discover() { return { sessions: [], warnings: [] }; },
    async create() {
      creates += 1;
      throw new Error("provider unavailable");
    },
  };
  const workspace = {
    async focusOrOpen() {},
    async leave() { return { closeOverview: true }; },
  };
  const running = runOverview({ bridge, workspace, defaultCwd: "/work/new", inputStream: input, outputStream: output, refreshMs: 60_000, listenForSignals: false });
  await new Promise((resolve) => setImmediate(resolve));

  pressAlt(input, "n");
  input.emit("keypress", "", { name: "return" });
  assert.match(plain(output.writes.at(-1)), /프롬프트를 입력하세요/);
  assert.equal(creates, 0);

  input.emit("keypress", "실패해도 유지", { sequence: "실패해도 유지" });
  input.emit("keypress", "", { name: "return" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(creates, 1);
  assert.match(plain(output.writes.at(-1)), /오류: provider unavailable/);
  assert.match(plain(output.writes.at(-1)), /› 실패해도 유지/);

  input.emit("keypress", "", { name: "escape" });
  assert.doesNotMatch(plain(output.writes.at(-1)), /새 세션 생성|provider unavailable|실패해도 유지/);
  pressAlt(input, "q");
  assert.equal(await running, 0);
});
