import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import headless from "@xterm/headless";
import { buildOverviewFrame } from "../src/overview.mjs";

const sessions = [
  { provider: "claude", kind: "interactive", id: "claude:12345678-aaaa-4000-8000-000000000001", name: "Interactive", status: "idle", cwd: "/work" },
  { provider: "claude", kind: "background", id: "claude:12345678-bbbb-4000-8000-000000000002", nativeId: "short-command", name: "Background", status: "working", cwd: "/work" },
  { provider: "codex", id: "codex:12345678-aaaa-4000-8000-000000000003", name: "Codex", status: "idle", cwd: "/work" },
];

test("status rows fit real terminal cells and keep the project visible for long paths", async () => {
  const session = { ...sessions[2], name: "긴 세션 이름 ".repeat(8), cwd: "/home/ubuntu/Projects/keeper" };
  for (const width of [40, 80, 150]) {
    const frame = buildOverviewFrame({ sessions: [session], viewMode: "status", selected: 1,
      hostLabel: "oracle-vm", width, height: 30 });
    const terminal = new headless.Terminal({ cols: width, rows: 30, convertEol: true, allowProposedApi: true });
    try {
      await new Promise(resolve => terminal.write(frame, resolve));
      assert.equal(terminal.buffer.active.baseY, 0, "the frame must not push content into scrollback");
      for (let row = 0; row < 30; row++) assert.equal(terminal.buffer.active.getLine(row).isWrapped, false, `unexpected wrap at ${width} columns, row ${row}`);
      assert.match(stripVTControlCharacters(frame), width >= 80 ? /oracle-vm \/ keeper/ : /oracle-vm \/ \/home\/ubuntu\/Projects/);
    } finally { terminal.dispose(); }
  }
});

function render(rows = sessions, options = {}) {
  return stripVTControlCharacters(buildOverviewFrame({
    sessions: rows,
    nodes: rows.map(session => ({ type: "session", session })),
    width: 150, height: 30, notice: "NOTICE", ...options,
  }));
}

test("Dock labels use canonical IDs for Claude CLI, BG and Codex", () => {
  const frame = render();
  assert.match(frame, /\[12345678-a\] CLAUDE\s+CLI · Interactive/);
  assert.match(frame, /\[12345678-b\] CLAUDE\s+BG · Background/);
  // Claude's colliding prefix must not lengthen the Codex label.
  assert.match(frame, /\[12345678\] CODEX\s+Codex/);
  assert.doesNotMatch(frame, /short-command/);
  assert.ok(frame.indexOf(sessions[0].id) < frame.indexOf("NOTICE"));
});

test("labels survive rename and reorder and distinguish offscreen discovered IDs", () => {
  const renamed = sessions.map(session => ({ ...session, name: `Renamed ${session.provider}` })).reverse();
  const frame = render(renamed);
  assert.match(frame, /\[12345678-b\] CLAUDE\s+BG · Renamed claude/);
  assert.match(frame, /\[12345678-a\] CLAUDE\s+CLI · Renamed claude/);
  assert.match(frame, /\[12345678\] CODEX\s+Renamed codex/);
  const offscreen = render(sessions, { nodes: [{ type: "session", session: sessions[0] }] });
  assert.match(offscreen, /\[12345678-a\] CLAUDE\s+CLI · Interactive/);
  const independent = render([sessions[0], sessions[2]]);
  assert.match(independent, /\[12345678\] CLAUDE\s+CLI · Interactive/);
  const longName = render([{ ...sessions[2], name: "Long session name ".repeat(20) }]);
  assert.match(longName, /○ \[12345678\] CODEX\s+Long session name/);
});

test("selected canonical IDs wrap and leave notice and help in bounded frames", () => {
  for (const [width, height] of [[40, 14], [80, 20], [150, 30]]) {
    for (let selected = 0; selected < sessions.length; selected++) {
      for (const warnings of [[], [{ provider: "claude", message: "WARNING" }]]) {
        const frame = render(sessions, { width, height, selected, warnings });
        const lines = frame.split("\n");
        assert.ok(lines.length <= height);
        for (const line of lines) assert.ok([...line].length <= width, line);
        assert.doesNotMatch(frame, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
        const noticeIndex = lines.findIndex(line => line.includes(warnings.length ? "WARNING" : "NOTICE"));
        assert.ok(noticeIndex > 0);
        const identityRows = width === 40 ? 2 : 1;
        assert.equal(lines.slice(noticeIndex - identityRows, noticeIndex).map(line => line.trim()).join(""), sessions[selected].id);
        assert.match(frame, /Enter 열기/);
        assert.match(frame, /F4 재접속/);
        assert.match(frame, /Alt\+D/);
        assert.match(frame, /tmux/);
      }
    }
  }
});

test("workspace selection has no stale full identity and simple IDs need no nativeId", () => {
  const simple = [{ ...sessions[2], id: "codex:1", name: "Simple" }];
  assert.match(render(simple), /\[1\] CODEX\s+Simple/);
  assert.match(render(simple), /codex:1/);
  const frame = render(sessions, {
    nodes: [{ type: "workspace", name: "work", cwd: "/work", sessionCount: 3 }, ...sessions.map(session => ({ type: "session", session }))],
    selected: 0,
  });
  for (const session of sessions) assert.ok(!frame.includes(session.id));
});

test("identity text cannot inject terminal controls", () => {
  const unsafe = [{ ...sessions[2], id: "codex:abcd\n\u001b[2Jefgh", name: "Safe" }];
  const raw = buildOverviewFrame({ sessions: unsafe, nodes: [{ type: "session", session: unsafe[0] }], width: 80, height: 20 });
  assert.ok(!raw.includes("\u001b[2J"));
  assert.match(stripVTControlCharacters(raw), /codex:abcd \[2Jefgh/);
});
