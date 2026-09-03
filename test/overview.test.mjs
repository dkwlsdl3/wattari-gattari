import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  applyOverviewOrder,
  buildOverviewFrame,
  buildOverviewTree,
  moveOverviewSession,
  nativeReturnHint,
  reconcileOverviewOrder,
  runOverview,
  selectOverviewSessions,
} from "../src/overview.mjs";

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

test("overview reconciles discovered sessions with manual workspace order", () => {
  const order = reconcileOverviewOrder(new Map([["/work/api", ["codex:old", "codex:1"]]]), sessions);
  assert.deepEqual(order.get("/work/api"), ["codex:old", "codex:1"]);
  assert.deepEqual(order.get("/work/ui"), ["claude:2"]);
  assert.deepEqual(applyOverviewOrder([...sessions].reverse(), order).map((session) => session.id), ["codex:1", "claude:2", "codex:3"]);

  const moved = moveOverviewSession(new Map([["/work/shared", ["codex:1", "hidden", "claude:2"]]]), "/work/shared", "codex:1", "down", ["codex:1", "claude:2"]);
  assert.deepEqual(moved.get("/work/shared"), ["claude:2", "hidden", "codex:1"]);
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
  assert.match(frame, /Alt\+Q 나가기/);
  assert.match(frame, /Shift\+↑↓ 순서/);
  assert.match(frame, /tmux prefix \+ 0/);
  assert.match(frame, /\x1b\[1;38;2;56;189;248m/);
  assert.doesNotMatch(frame, /\x1b\[38;5;/);
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
    await waitFor(() => /새 세션 ·/.test(plain(output.writes.at(-1))));
    const started = performance.now();
    input.write("\u001b");
    await waitFor(() => !/새 세션 ·/.test(plain(output.writes.at(-1))));
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

test("overview discovery is global unless a cwd filter is explicit", async () => {
  for (const [filterCwd, expected] of [[null, {}], ["/tmp/project", { cwd: "/tmp/project" }]]) {
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
  assert.doesNotMatch(plain(output.writes.at(-1)), /새 세션 ·/);

  pressAlt(input, "r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(discoveries, discoveriesBeforeRefresh + 1);
  pressAlt(input, "q");
  assert.equal(await running, 0);
  assert.equal(leaves, 1);
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
  assert.doesNotMatch(plain(output.writes.at(-1)), /새 세션 ·/);
  pressAlt(input, "n");
  assert.match(plain(output.writes.at(-1)), /새 세션 · CLAUDE · \/work\/new/);
  input.emit("keypress", "", { name: "tab" });
  assert.match(plain(output.writes.at(-1)), /새 세션 · CODEX · \/work\/new/);
  input.emit("keypress", "작업", { sequence: "작업" });
  input.emit("keypress", "", { name: "left" });
  input.emit("keypress", "새", { sequence: "새" });
  assert.match(plain(output.writes.at(-1)), /› 작새업/);
  input.emit("keypress", "", { name: "return" });
  await createCalled;
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(created, { provider: "codex", prompt: "작새업", options: { cwd: "/work/new" } });
  assert.equal(selectedSessionName(output), "작새업");
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
  assert.doesNotMatch(plain(output.writes.at(-1)), /새 세션 ·|provider unavailable|실패해도 유지/);
  pressAlt(input, "q");
  assert.equal(await running, 0);
});
