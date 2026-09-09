import assert from "node:assert/strict";
import test from "node:test";

import { fallbackRouting, routingSummary } from "../src/model-router.mjs";

test("Waga fallback does not choose a product-specific model", () => {
  const routing = fallbackRouting({ provider: "codex", cwd: "/work/project" });
  assert.deepEqual({ model: routing.model, effort: routing.effort, tier: routing.tier }, {
    model: null,
    effort: null,
    tier: "default",
  });
  assert.equal(routing.source, "waga-fallback");
  assert.equal(routing.cwd, "/work/project");
});

test("fallback identifies the selected provider in the preview", () => {
  const routing = fallbackRouting({ provider: "claude" });
  assert.match(routingSummary(routing), /Claude 기본값/);
  assert.match(routingSummary(routing), /local-llm-router 조회 전/);
});

test("routing summary reports an external router warning", () => {
  const routing = {
    provider: "codex",
    label: "Codex 기본값",
    source: "waga-fallback",
    reasons: ["provider 기본값 (+0)"],
    warnings: ["router unavailable"],
  };
  assert.match(routingSummary(routing), /경고: router unavailable/);
});
