import assert from "node:assert/strict";
import test from "node:test";
import { DraftStore } from "../src/web/drafts.mjs";

test("drafts survive page reload and remain isolated by work step and native recipient", () => {
  const storage = new Map(), api = { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) };
  const first = new DraftStore(api);
  first.set("flow:edit:claude:A", "A에게 보낼 내용"); first.set("flow:edit:codex:B", "B에게 보낼 내용");
  const reloaded = new DraftStore(api);
  assert.equal(reloaded.get("flow:edit:claude:A"), "A에게 보낼 내용"); assert.equal(reloaded.get("flow:edit:codex:B"), "B에게 보낼 내용");
  assert.equal(reloaded.get("flow:verify:claude:A"), undefined);
  reloaded.delete("flow:edit:claude:A"); assert.equal(new DraftStore(api).get("flow:edit:claude:A"), undefined);
});

test("disabled or corrupt browser storage keeps drafts usable in memory", () => {
  const drafts = new DraftStore({ getItem() { return "broken"; }, setItem() { throw new Error("denied"); } });
  drafts.set("key", "input"); assert.equal(drafts.get("key"), "input");
});
