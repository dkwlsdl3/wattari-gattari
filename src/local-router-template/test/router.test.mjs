import test from "node:test";
import assert from "node:assert/strict";

import { extractIssueReferences, normalizeIssue, routeTask } from "../src/router.mjs";

test("extracts unique issue references", () => {
  assert.deepEqual(extractIssueReferences("#123 확인하고 #123와 #12도 봐줘"), ["123", "12"]);
});

test("normalizes title, labels, description, and non-system comments", () => {
  const issue = normalizeIssue({
    iid: 12,
    title: "Example recovery",
    description: "D-state에서 fail-closed를 확인한다.",
    labels: [{ name: "reliability" }, "backend"],
    notes: [{ body: "재현 로그를 첨부했다." }, { system: true, body: "label changed" }],
  });
  assert.deepEqual(issue.labels, ["reliability", "backend"]);
  assert.equal(issue.commentCount, 1);
  assert.match(issue.text, /Example recovery/);
  assert.match(issue.text, /재현 로그/);
  assert.doesNotMatch(issue.text, /label changed/);
});

test("uses issue metadata when the prompt has only an issue number", async () => {
  const routing = await routeTask({
    provider: "codex",
    prompt: "#123 확인해봐",
    config: {
      promotionThreshold: 3,
      issue: { enabled: true, maxIssues: 3, maxComments: 50, maxChars: 65_536 },
      profiles: {
        codex: { default: { model: "small", effort: "max", label: "small" }, promoted: { model: "large", effort: "low", label: "large" } },
      },
    },
    fetchIssue: async () => ({ title: "Example recovery", description: "Example recovery workflow", labels: ["reliability"] }),
  });
  assert.equal(routing.model, "large");
  assert.deepEqual(routing.issueRefs, ["123"]);
  assert.equal(routing.issues[0].labels[0], "reliability");
  assert.ok(routing.reasons.some((reason) => reason.includes("이슈 메타데이터")));
});

test("falls back to prompt-only routing when issue lookup is unauthorized", async () => {
  const routing = await routeTask({
    provider: "codex",
    prompt: "#123 확인해봐",
    config: {
      promotionThreshold: 3,
      issue: { enabled: true, maxIssues: 3, maxComments: 50, maxChars: 65_536 },
      profiles: {
        codex: { default: { model: "small", effort: "max", label: "small" }, promoted: { model: "large", effort: "low", label: "large" } },
      },
    },
    fetchIssue: async () => { throw new Error("401 Unauthorized"); },
  });
  assert.equal(routing.model, "large");
  assert.match(routing.warnings[0], /401 Unauthorized/);
  assert.equal(routing.issues.length, 0);
});
