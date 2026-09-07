import assert from "node:assert/strict";
import test from "node:test";
import { retainedCodexViewMatches } from "../src/providers/codex-view.mjs";

// Captured from isolated Codex 0.153.2: /agents changes neither PID nor title.
const one = "01a07a2e-c4ce-75c1-9fb4-02192b587721";
const two = "01a07a2e-cabf-7fe0-84f7-f4557a6be9a4";
const marker = (id) => `${id.slice(0, 29)}...`;
const chat = "╭────────────────────────────────────────────────────╮\n│ >_ OpenAI Codex (v0.153.2)                         │\n";
const agents = "  Agent command center\n  0 need input   2 working   0 ready\n";

test("Codex view identifies the displayed thread, not the original resume argv", () => {
  assert.equal(retainedCodexViewMatches(one, marker(one), chat), true);
  assert.equal(retainedCodexViewMatches(one, one, chat), true);
  assert.equal(retainedCodexViewMatches(one, marker(two), chat), false);
  assert.equal(retainedCodexViewMatches(one, marker(one), agents), false);
});

test("Codex view refuses missing, malformed, short, or unknown title formats", () => {
  for (const title of ["", "Codex", one.slice(0, 8), one.slice(0, 29), `${one} extra`]) {
    assert.equal(retainedCodexViewMatches(one, title, chat), false, title);
  }
  assert.equal(retainedCodexViewMatches(undefined, marker(one), chat), false);
  assert.equal(retainedCodexViewMatches("not-a-thread", "not-a-thread", chat), false);
  assert.equal(retainedCodexViewMatches(one, marker(one), ""), false);
  assert.equal(retainedCodexViewMatches(one, marker(one), undefined), false);
});

test("Codex blank top rows do not override a matching thread title", () => {
  // Codex 0.153.4 resume proof: capture-pane -S 0 -E 1 returned two blank rows.
  for (const frame of ["\n\n", " \n"]) {
    assert.equal(retainedCodexViewMatches(one, marker(one), frame), true);
    assert.equal(retainedCodexViewMatches(one, one, frame), true);
    assert.equal(retainedCodexViewMatches(one, marker(two), frame), false);
    assert.equal(retainedCodexViewMatches(one, "", frame), false);
  }
});

test("Codex truncated titles with known prefix collisions are not reused", () => {
  const collision = `${one.slice(0, 29)}0000000`;
  assert.equal(retainedCodexViewMatches(one, marker(one), chat, [one, two]), true);
  assert.equal(retainedCodexViewMatches(one, marker(one), chat, [one, collision]), false);
  assert.equal(retainedCodexViewMatches(one, one, chat, [one, collision]), true);
});
