import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { buildOverviewFrame, runOverview, selectOverviewSessions } from "../src/overview.mjs";

const sessions = [
  { id: "codex:1", provider: "codex", status: "idle", name: "API 검토", cwd: "/work/api", updatedAt: 20 },
  { id: "claude:2", provider: "claude", status: "working", name: "UI 구현", cwd: "/work/ui", updatedAt: 10 },
  { id: "codex:3", provider: "codex", status: "needs-input", name: "배포 확인", cwd: "/work/ops", updatedAt: 5 },
];

test("overview prioritizes attention and working sessions before idle history", () => {
  assert.deepEqual(selectOverviewSessions(sessions).map((session) => session.id), ["codex:3", "claude:2", "codex:1"]);
});

test("overview filtering is provider agnostic and searches names and paths", () => {
  assert.deepEqual(selectOverviewSessions(sessions, { query: "ui" }).map((session) => session.id), ["claude:2"]);
  assert.deepEqual(selectOverviewSessions(sessions, { query: "API 검토" }).map((session) => session.id), ["codex:1"]);
});

test("overview frame distinguishes providers and keeps navigation help visible", () => {
  const frame = buildOverviewFrame({ sessions, selected: 1, width: 100, height: 20, query: "", warnings: [] });
  assert.match(frame, /WATTARI GATTARI/);
  assert.match(frame, /CODEX/);
  assert.match(frame, /CLAUDE/);
  assert.match(frame, /Enter 열기/);
  assert.match(frame, /tmux prefix \+ 0/);
});

test("overview frame switches to a compact layout when the terminal narrows", () => {
  const frame = buildOverviewFrame({ sessions, selected: 1, width: 40, height: 14, query: "API", warnings: [] });
  assert.match(frame, /WAGA/);
  assert.match(frame, /CLAUDE/);
  assert.match(frame, /검색/);
  assert.doesNotMatch(frame, /\/work\/ui/);
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
