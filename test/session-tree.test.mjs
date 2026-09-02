import assert from "node:assert/strict";
import test from "node:test";

import { preserveCursor, sessionTree } from "../src/session-tree.mjs";

const state = {
  revision: 3,
  workspaces: [
    { path: "/workspace/sample-app", name: "sample-app", sessions: [{ id: "codex:1", name: "one" }, { id: "codex:2", name: "two" }] },
    { path: "/workspace/dotfiles", name: "dotfiles", sessions: [] },
  ],
};

test("makes workspace headers and sessions part of one selectable tree", () => {
  assert.deepEqual(sessionTree(state).map(({ type, key }) => [type, key]), [
    ["workspace", "workspace:/workspace/sample-app"],
    ["session", "codex:1"],
    ["session", "codex:2"],
    ["workspace", "workspace:/workspace/dotfiles"],
  ]);
});

test("keeps an empty workspace selectable and collapse state local", () => {
  const collapsed = new Set(["/workspace/sample-app"]);
  const nodes = sessionTree(state, collapsed);
  assert.deepEqual(nodes.map(({ key }) => key), [
    "workspace:/workspace/sample-app",
    "workspace:/workspace/dotfiles",
  ]);
  assert.equal(preserveCursor(nodes, "workspace:/workspace/dotfiles"), 1);
});
