import assert from "node:assert/strict";
import test from "node:test";
import { retainedCodexViewState } from "../src/providers/codex-view.mjs";

// Captured from isolated Codex 0.153.2: /agents changes neither PID nor title.
const one = "01a07a2e-c4ce-75c1-9fb4-02192b587721";
const two = "01a07a2e-cabf-7fe0-84f7-f4557a6be9a4";
const marker = (id) => `${id.slice(0, 29)}...`;
const chat = "╭────────────────────────────────────────────────────╮\n│ >_ OpenAI Codex (v0.153.2)                         │\n";
const agents = "  Agent command center\n  0 need input   2 working   0 ready\n";

test("Codex view identifies the displayed thread, not the original resume argv", () => {
  assert.equal(retainedCodexViewState(one, marker(one), chat), "same");
  assert.equal(retainedCodexViewState(one, one, chat), "same");
  assert.equal(retainedCodexViewState(one, marker(two), chat, [one, two]), "different");
  assert.equal(retainedCodexViewState(one, marker(one), agents), "different");
});

test("Codex view treats missing, malformed, short, or unknown title formats as unknown", () => {
  for (const title of ["", "Codex", one.slice(0, 8), one.slice(0, 29), `${one} extra`]) {
    assert.equal(retainedCodexViewState(one, title, chat), "unknown", title);
  }
  assert.equal(retainedCodexViewState(undefined, marker(one), chat), "unknown");
  assert.equal(retainedCodexViewState("not-a-thread", "not-a-thread", chat), "unknown");
  assert.equal(retainedCodexViewState(one, marker(one), ""), "unknown");
  assert.equal(retainedCodexViewState(one, marker(one), undefined), "unknown");
});

test("Codex blank top rows do not override a matching thread title", () => {
  // Codex 0.153.4 resume proof: capture-pane -S 0 -E 1 returned two blank rows.
  for (const frame of ["\n\n", " \n"]) {
    assert.equal(retainedCodexViewState(one, marker(one), frame), "same");
    assert.equal(retainedCodexViewState(one, one, frame), "same");
    assert.equal(retainedCodexViewState(one, marker(two), frame, [one, two]), "different");
    assert.equal(retainedCodexViewState(one, "", frame), "unknown");
  }
});

test("Codex truncated titles with known prefix collisions are unknown", () => {
  const collision = `${one.slice(0, 29)}0000000`;
  assert.equal(retainedCodexViewState(one, marker(one), chat, [one, two]), "same");
  assert.equal(retainedCodexViewState(one, marker(one), chat, [one, collision]), "unknown");
  assert.equal(retainedCodexViewState(one, one, chat, [one, collision]), "same");
});

test("Codex foreign titles prove navigation even before discovery knows the thread", () => {
  assert.equal(retainedCodexViewState(one, two, chat), "different");
  // Proven by test/tmux-integration.test.mjs: a thread opened inside Codex is
  // not in knownNativeIds yet, and the retained view must still be invalidated.
  assert.equal(retainedCodexViewState(one, marker(two), chat), "different");
  assert.equal(retainedCodexViewState(one, marker(two), chat, [one]), "different");
  assert.equal(retainedCodexViewState(one, marker(one), chat, [one, one]), "same");
  assert.equal(retainedCodexViewState(one, "", agents), "different");
});
