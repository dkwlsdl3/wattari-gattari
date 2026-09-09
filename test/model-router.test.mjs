import assert from "node:assert/strict";
import test from "node:test";

import { routeTask, routingSummary } from "../src/model-router.mjs";

test("plain tasks use the cost-conscious Codex default", () => {
  const routing = routeTask({ provider: "codex", prompt: "작은 문서 오탈자를 고쳐 주세요." });
  assert.deepEqual({ model: routing.model, effort: routing.effort, tier: routing.tier }, {
    model: "gpt-5.6-luna",
    effort: "max",
    tier: "default",
  });
  assert.equal(routing.confidence, "low");
  assert.deepEqual(routing.skills, []);
});

test("an explicit issue-loop skill promotes even when the issue number is opaque", () => {
  const routing = routeTask({
    provider: "codex",
    prompt: "이슈루프 스킬써서 #123번 이슈 확인해봐",
    cwd: "/work/sample-app",
  });
  assert.equal(routing.model, "gpt-6-astra");
  assert.equal(routing.effort, "low");
  assert.equal(routing.tier, "promoted");
  assert.deepEqual(routing.skills, ["issue-loop"]);
  assert.match(routing.reasons.join(" "), /issue-loop/);
  assert.equal(routing.cwd, "/work/sample-app");
});

test("an issue reference with an action is routed without an explicit skill", () => {
  const routing = routeTask({ provider: "codex", prompt: "#123번 이슈 확인해봐" });
  assert.equal(routing.skills.length, 0);
  assert.equal(routing.tier, "promoted");
  assert.equal(routing.model, "gpt-6-astra");
  assert.ok(routing.reasons.some((reason) => reason.includes("이슈 작업")));
});

test("unstated skills are inferred from risky task language", () => {
  const routing = routeTask({
    provider: "codex",
    prompt: "Lustre watchdog의 D-state 원인을 재현하고 fail-closed 복구를 검토해 주세요.",
  });
  assert.equal(routing.tier, "promoted");
  assert.equal(routing.model, "gpt-6-astra");
  assert.ok(routing.reasons.some((reason) => reason.includes("스토리지")));
  assert.ok(routing.reasons.some((reason) => reason.includes("장애")));
  assert.ok(routing.reasons.some((reason) => reason.includes("원인")));
});

test("the same routing signals use provider-specific Claude profiles", () => {
  const routing = routeTask({ provider: "claude", prompt: "$issue-loop로 migration 리뷰를 진행해 주세요." });
  assert.deepEqual({ model: routing.model, effort: routing.effort }, { model: "fable", effort: "high" });
  assert.match(routingSummary(routing), /Claude Fable · high/);
});

test("routing summary explains the default when no signal matches", () => {
  const routing = routeTask({ provider: "codex", prompt: "README의 문장을 다듬어 주세요." });
  assert.equal(routingSummary(routing), "자동 라우팅: GPT-5.6 Luna · max · 기본 작업 프로파일 (+0)");
});

test("unknown providers fail before a provider can be launched", () => {
  assert.throws(() => routeTask({ provider: "unknown", prompt: "task" }), /Unknown routing provider/);
});
