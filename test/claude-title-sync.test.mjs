import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ClaudeTitleSync } from "../src/claude-title-sync.mjs";
import { ClaudeProvider } from "../src/providers/claude.mjs";

const id = "26bce3ae-3d65-4f9a-b3a1-bb8c6d3bc247";
const other = "26bce3ae-3d65-4f9a-b3a1-bb8c6d3bc248";
// Measured Claude 2.1.263 UserPromptSubmit shape; only paths/prompt sanitized.
const prompt = { session_id: id, transcript_path: "/tmp/waga-proof/transcript.jsonl", cwd: "/tmp/waga-proof", prompt_id: "8b77c7f6-9483-4a91-8d6d-4ea80fe90990", permission_mode: "default", hook_event_name: "UserPromptSubmit", prompt: "waga-proof", session_title: "before" };
const start = { session_id: id, hook_event_name: "SessionStart", source: "startup" };
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-title-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return new ClaudeTitleSync(path.join(root, "state"));
}

test("title hook registers capability without renaming at startup", (t) => {
  const sync = setup(t);
  assert.equal(sync.available(id), false);
  assert.equal(sync.queue(id, "ignored"), false);
  assert.equal(sync.display(id, "native"), null);
  assert.equal(sync.hook(start), null);
  assert.equal(new ClaudeTitleSync(sync.directory).available(id), true);
  assert.deepEqual(sync.display(id, "native"), { name: "native", nameSync: "native" });
  assert.equal(sync.hook(prompt), null);
  assert.equal(fs.statSync(sync.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(sync.directory, `${id}.ready.json`)).mode & 0o777, 0o600);
});

test("pending title is delivered once; later native rename is respected", (t) => {
  const sync = setup(t);
  sync.hook(start);
  assert.equal(sync.queue(id, "  검토 'UI' $HOME  "), true);
  assert.deepEqual(sync.display(id, "before"), { name: "검토 'UI' $HOME", nameSync: "pending" });
  assert.equal(sync.hook({ ...prompt, session_id: other }), null);
  const expected = { hookSpecificOutput: { hookEventName: "UserPromptSubmit", sessionTitle: "검토 'UI' $HOME" } };
  assert.deepEqual(new ClaudeTitleSync(sync.directory).hook(prompt), expected);
  assert.equal(sync.hook(prompt), null);
  assert.deepEqual(sync.display(id, "later /rename"), { name: "later /rename", nameSync: "native" });
  assert.equal(sync.hook({ ...start, source: "resume" }), null);
  assert.equal(sync.hook(prompt), null, "resume cannot replay consumed requests");
  sync.queue(id, "second");
  sync.queue(id, "latest");
  assert.equal(sync.hook(prompt).hookSpecificOutput.sessionTitle, "latest");
  assert.equal(sync.hook(prompt), null);
});

test("a newer request written while the hook emits an older one is not lost", (t) => {
  const sync = setup(t);
  sync.hook(start);
  sync.queue(id, "A");
  const original = fs.renameSync;
  t.mock.method(fs, "renameSync", (from, to) => {
    if (to.endsWith(".receipt.json")) sync.queue(id, "B");
    return original(from, to);
  });
  assert.equal(sync.hook(prompt).hookSpecificOutput.sessionTitle, "A");
  t.mock.restoreAll();
  assert.deepEqual(sync.display(id, "A"), { name: "B", nameSync: "pending" });
  assert.equal(sync.hook(prompt).hookSpecificOutput.sessionTitle, "B");
  assert.equal(sync.hook(prompt), null);
});

test("invalid identifiers, subagents and unrelated events cannot queue or consume titles", (t) => {
  const sync = setup(t);
  assert.throws(() => new ClaudeTitleSync("relative"), TypeError);
  for (const session_id of [undefined, "../outside", "26bce3ae", ""]) {
    assert.equal(sync.hook({ ...start, session_id }), null);
    assert.equal(sync.queue(session_id, "no"), false);
  }
  assert.equal(sync.hook({ ...start, agent_id: "subagent" }), null);
  assert.equal(sync.available(id), false);
  sync.hook(start);
  for (const name of ["", "  ", "a\nb", "a\x1bb", null]) assert.throws(() => sync.queue(id, name), TypeError);
  sync.queue(id, "safe");
  assert.equal(sync.hook({ ...prompt, agent_id: "subagent" }), null);
  assert.equal(sync.hook({ ...prompt, hook_event_name: "Stop" }), null);
  assert.equal(sync.hook(prompt).hookSpecificOutput.sessionTitle, "safe");
});

test("rename write failure preserves the last request and removes temporary files", (t) => {
  const sync = setup(t);
  sync.hook(start);
  sync.queue(id, "before");
  t.mock.method(fs, "renameSync", () => { throw new Error("disk failure"); });
  assert.throws(() => sync.queue(id, "after"), /disk failure/);
  assert.deepEqual(sync.display(id, "native"), { name: "before", nameSync: "pending" });
  assert.ok(fs.readdirSync(sync.directory).every(file => !file.endsWith(".tmp")));
});

test("provider queues native sync without a sticky alias; storage errors surface on rename", async (t) => {
  const sync = setup(t);
  sync.hook(start);
  const provider = new ClaudeProvider({ titleSync: sync, aliasCatalog: { set() { throw new Error("must not set alias"); } } });
  assert.deepEqual(await provider.rename({ id: `claude:${id}`, sessionId: id }, " next "), { target: `claude:${id}`, renamed: true, name: "next", nameSync: "pending" });
  fs.writeFileSync(path.join(sync.directory, `${id}.request.json`), "invalid");
  assert.equal(sync.display(id, "native"), null, "bad optional state does not break discovery");
  fs.writeFileSync(path.join(sync.directory, `${id}.ready.json`), "invalid");
  await assert.rejects(provider.rename({ id: `claude:${id}`, sessionId: id }, "next"));
});

test("real hook process consumes measured input and fails open without context output", (t) => {
  const sync = setup(t);
  const hook = fileURLToPath(new URL("../src/claude-title-hook.mjs", import.meta.url));
  const run = input => {
    const result = spawnSync(process.execPath, [hook, sync.directory], { input, encoding: "utf8", timeout: 5000 });
    assert.ifError(result.error);
    return result;
  };
  assert.equal(run(JSON.stringify(start)).stdout, "");
  sync.queue(id, "renamed");
  const result = run(JSON.stringify(prompt));
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.sessionTitle, "renamed");
  assert.equal(run(JSON.stringify(prompt)).stdout, "");
  for (const input of ["invalid", " ".repeat(256 * 1024 + 1)]) {
    const failed = run(input);
    assert.equal(failed.status, 0);
    assert.equal(failed.stdout, "");
    assert.match(failed.stderr, /title sync skipped/);
  }
  fs.writeFileSync(path.join(sync.directory, `${id}.request.json`), JSON.stringify({ id: "invalid", name: "bad" }));
  assert.match(run(JSON.stringify(prompt)).stderr, /title sync skipped/);
});

test("per-launch settings quote paths and preserve the caller's other settings", (t) => {
  const sync = setup(t);
  const tricky = new ClaudeTitleSync(path.join(sync.directory, "space ' quote $HOME"));
  const settings = JSON.parse(tricky.settings());
  assert.deepEqual(Object.keys(settings), ["hooks"]);
  assert.equal(settings.hooks.SessionStart[0].matcher, "startup|resume");
  const command = settings.hooks.UserPromptSubmit[0].hooks[0].command;
  const result = spawnSync("/bin/sh", ["-c", command], { input: JSON.stringify(start), encoding: "utf8", timeout: 5000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.equal(tricky.available(id), true);
});
