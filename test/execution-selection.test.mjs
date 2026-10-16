import test from "node:test";
import assert from "node:assert/strict";
import { chooseSelection, currentTarget, keepsInspector } from "../src/web/execution-selection.mjs";

const work = (id, updatedAt, revision = 1, launches = []) => ({ id, plan: { updatedAt, revision }, launches });
const pick = (works, runs, pinned, extra = []) => {
  const current = currentTarget(works, runs);
  const ids = [...runs.map(run => `run:${run.id}`), ...works.filter(w => w.plan && !runs.some(r => r.workId === w.id && w.launches?.some(l => l.runId === r.id && l.planRevision === w.plan.revision))).map(w => `plan:${w.id}`), ...extra];
  return chooseSelection({ pinned, ids, current });
};

test("a newer plan replaces the previously followed one", () => {
  const old = work("a", 1);
  assert.equal(pick([old], [], null).value, "plan:a");
  assert.equal(pick([old, work("b", 2)], [], null).value, "plan:b");
});

test("plan hands off to its exact planRevision run only", () => {
  const stale = { id: "r1", workId: "a" }, fresh = { id: "r2", workId: "a" };
  const w = work("a", 5, 2, [{ runId: "r1", planRevision: 1 }]);
  assert.equal(currentTarget([w], [stale]), "plan:a");
  w.launches.push({ runId: "r2", planRevision: 2 });
  assert.equal(currentTarget([w], [stale, fresh]), "run:r2");
});

test("explicit older history stays pinned across refresh and returns to current", () => {
  const works = [work("a", 1), work("b", 2)];
  assert.deepEqual(pick(works, [], "plan:a"), { value: "plan:a", pinned: "plan:a" });
  works.push(work("c", 3));
  assert.equal(pick(works, [], "plan:a").value, "plan:a");
  assert.deepEqual(pick(works, [], null), { value: "plan:c", pinned: null });
  assert.deepEqual(pick(works, [], "plan:c"), { value: "plan:c", pinned: null });
});

test("a vanished pin falls back to current; session reset (no pin) follows current", () => {
  assert.deepEqual(pick([work("b", 2)], [], "plan:gone"), { value: "plan:b", pinned: null });
  assert.equal(pick([work("b", 2), work("a", 1)], [], null).value, "plan:b");
});

test("inspector is kept only for the same execution", () => {
  assert.equal(keepsInspector(true, "run:1", "run:1"), true);
  assert.equal(keepsInspector(true, "plan:1", "run:1"), false);
  assert.equal(keepsInspector(false, "run:1", "run:1"), false);
});
