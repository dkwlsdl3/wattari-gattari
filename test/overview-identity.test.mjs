import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { buildOverviewFrame } from "../src/overview.mjs";

const sessions = [
  { provider: "claude", kind: "interactive", id: "claude:12345678-aaaa-4000-8000-000000000001", name: "Interactive", status: "idle", cwd: "/work" },
  { provider: "claude", kind: "background", id: "claude:12345678-bbbb-4000-8000-000000000002", nativeId: "short-command", name: "Background", status: "working", cwd: "/work" },
  { provider: "codex", id: "codex:12345678-aaaa-4000-8000-000000000003", name: "Codex", status: "idle", cwd: "/work" },
];

function render(rows = sessions, options = {}) {
  return stripVTControlCharacters(buildOverviewFrame({
    sessions: rows,
    nodes: rows.map(session => ({ type: "session", session })),
    width: 150, height: 30, notice: "NOTICE", ...options,
  }));
}

test("Dock labels use canonical IDs for Claude CLI, BG and Codex", () => {
  const frame = render();
  assert.match(frame, /CLI · Interactive \[12345678-a\]/);
  assert.match(frame, /BG · Background \[12345678-b\]/);
  // Claude's colliding prefix must not lengthen the Codex label.
  assert.match(frame, /CODEX\s+Codex \[12345678\]/);
  assert.doesNotMatch(frame, /short-command/);
  assert.ok(frame.indexOf(sessions[0].id) < frame.indexOf("NOTICE"));
});

test("labels survive rename and reorder and distinguish offscreen discovered IDs", () => {
  const renamed = sessions.map(session => ({ ...session, name: `Renamed ${session.provider}` })).reverse();
  const frame = render(renamed);
  assert.match(frame, /BG · Renamed claude \[12345678-b\]/);
  assert.match(frame, /CLI · Renamed claude \[12345678-a\]/);
  assert.match(frame, /Renamed codex \[12345678\]/);
  const offscreen = render(sessions, { nodes: [{ type: "session", session: sessions[0] }] });
  assert.match(offscreen, /Interactive \[12345678-a\]/);
  const independent = render([sessions[0], sessions[2]]);
  assert.match(independent, /Interactive \[12345678\]/);
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
  assert.match(render(simple), /Simple \[1\]/);
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
