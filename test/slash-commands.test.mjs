import assert from "node:assert/strict";
import test from "node:test";

import {
  matchSlashCommands,
  officialSlashCommandCounts,
  slashCommand,
  slashCommandsFor,
} from "../src/slash-commands.mjs";

test("catalogues the current official Codex and Claude Code built-in command names", () => {
  assert.equal(officialSlashCommandCounts.codex, 51);
  assert.equal(officialSlashCommandCounts.claude, 111);
  assert.ok(slashCommandsFor("codex").some(({ name }) => name === "/debug-config"));
  assert.ok(slashCommandsFor("claude").some(({ name }) => name === "/workflow-authoring"));
  assert.equal(slashCommand("codex", "/compact").support, "provider");
  assert.equal(slashCommand("codex", "/permissions").support, "provider");
  assert.equal(slashCommand("claude", "/code-review").support, "provider");
  assert.equal(slashCommand("claude", "/artifacts").support, "attach");
});

test("searches the active provider menu and leaves arguments to command dispatch", () => {
  assert.deepEqual(matchSlashCommands("codex", "/stat").map(({ name }) => name), ["/status", "/statusline"]);
  assert.ok(matchSlashCommands("claude", "/work").some(({ name }) => name === "/workflows"));
  assert.deepEqual(matchSlashCommands("codex", "/rename hello"), []);
});
