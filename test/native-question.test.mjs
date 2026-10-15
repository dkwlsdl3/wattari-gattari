import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { nativeQuestion } from "../src/web/native-question.mjs";

const sample = name => fs.readFileSync(new URL(`./fixtures/native-questions/${name}-command.txt`, import.meta.url), "utf8").split("\n");

test("measured Claude approval preserves all four choices and the command being authorized", () => {
  const result = nativeQuestion(sample("claude"), "claude");
  assert.ok(result.text.includes("printf 카드승인 >"));
  assert.equal(result.choices[0].label, "Yes");
  assert.equal(result.choices.find(choice => choice.label === "No").key, "4");
  assert.ok(result.choices.some(choice => choice.label.includes("always allow access")));
  assert.ok(result.choices.some(choice => choice.label.includes("switch to auto mode")));
});

test("measured Codex approval keeps its different denial number and scoped alternatives", () => {
  const result = nativeQuestion(sample("codex"), "codex");
  assert.ok(result.text.includes("sleep 25; printf BUSY_DONE_V2 >"));
  assert.equal(result.choices.find(choice => choice.label.includes("No, and tell Codex")).key, "3");
  assert.ok(result.choices.some(choice => choice.label.includes("don't ask again")));
  assert.notEqual(result.signature, nativeQuestion(sample("claude"), "claude").signature);
});

test("ordinary numbered replies and incomplete menus never become approval controls", () => {
  assert.equal(nativeQuestion(["Here is the plan", "1. Yes", "2. No"], "claude"), null);
  assert.equal(nativeQuestion(["Do you want to proceed?", "❯ 1. Yes"], "claude"), null);
  assert.equal(nativeQuestion(["Do you want to proceed?", "❯ 1. Yes", "  2. Yes, always allow"], "claude"), null);
  assert.equal(nativeQuestion(sample("codex"), "claude"), null);
});

test("approval identity changes when the command or choices change, and ambiguous keys are rejected", () => {
  const lines = sample("claude"), original = nativeQuestion(lines, "claude");
  assert.notEqual(nativeQuestion(lines.map(line => line.replace("claude-card-yes.txt", "another-file.txt")), "claude").signature, original.signature);
  assert.notEqual(nativeQuestion(lines.map(line => line.replace("1. Yes", "1. Proceed")), "claude").signature, original.signature);
  assert.equal(nativeQuestion([...lines, "  1. Conflicting choice"], "claude"), null);
});
