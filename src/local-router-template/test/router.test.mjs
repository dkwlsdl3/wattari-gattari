import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  DEFAULT_CONFIG,
  MAX_PROMPT_BYTES,
  extractIssueReferences,
  fetchIssueFromGlab,
  normalizeIssue,
  routeTask,
  validateRoutingResponse,
} from "../src/router.mjs";

function customCodexConfig() {
  return {
    issue: { enabled: true, maxIssues: 3, maxComments: 50, maxChars: 65_536 },
    profiles: {
      codex: {
        tiers: {
          fast: { model: "small", effort: "low", label: "small" },
          routine: { model: "small", effort: "medium", label: "small-routine" },
          complex: { model: "large", effort: "low", label: "large" },
          critical: { model: "large", effort: "high", label: "large-critical" },
        },
      },
    },
  };
}

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

test("passes the abort signal and normalized cwd to glab issue lookup", async () => {
  const controller = new AbortController();
  let received;
  const issue = await fetchIssueFromGlab("12", {
    cwd: `${process.cwd()}/./`,
    signal: controller.signal,
    run: async (_command, _args, options) => {
      received = options;
      return { stdout: JSON.stringify({ title: "Example issue" }) };
    },
  });

  assert.equal(received.cwd, path.resolve(process.cwd()));
  assert.equal(received.signal, controller.signal);
  assert.equal(received.timeout, 5_000);
  assert.equal(issue.title, "Example issue");
});

test("uses issue metadata when the prompt has only an issue number", async () => {
  const routing = await routeTask({
    provider: "codex",
    prompt: "#123 확인해봐",
    config: customCodexConfig(),
    fetchIssue: async () => ({ title: "Example recovery", description: "Example recovery workflow", labels: ["reliability"] }),
  });
  validateRoutingResponse(routing, { expectedProvider: "codex" });
  assert.equal(routing.contractVersion, 1);
  assert.equal(routing.model, "large");
  assert.deepEqual(routing.issueRefs, ["123"]);
  assert.deepEqual(routing.issues[0], {
    iid: "123",
    title: "Example recovery",
    labels: ["reliability"],
    commentCount: 0,
  });
  assert.equal("text" in routing.issues[0], false);
  assert.ok(routing.reasons.some((reason) => reason.includes("이슈 메타데이터")));
});

test("falls back to prompt-only routing when issue lookup is unauthorized", async () => {
  const routing = await routeTask({
    provider: "codex",
    prompt: "#123 확인해봐",
    config: customCodexConfig(),
    fetchIssue: async () => { throw new Error("401 Unauthorized"); },
  });
  assert.equal(routing.model, "large");
  assert.match(routing.warnings[0], /401 Unauthorized/);
  assert.equal(routing.issues.length, 0);
});

test("selects a task tier without changing the requested provider", async () => {
  const prompt = "production 환경의 Lustre 파일시스템 watchdog 장애 원인 분석을 진행해 주세요.";
  const codex = await routeTask({ provider: "codex", prompt, config: DEFAULT_CONFIG });
  const claude = await routeTask({ provider: "claude", prompt, config: DEFAULT_CONFIG });

  assert.equal(codex.provider, "codex");
  assert.equal(codex.tier, "critical");
  assert.equal(codex.model, "gpt-6-astra");
  assert.equal(codex.effort, "xhigh");
  assert.equal(claude.provider, "claude");
  assert.equal(claude.tier, "critical");
  assert.equal(claude.model, "fable");
  assert.equal(claude.effort, "high");
});

test("uses the fast and routine profiles for low-signal work", async () => {
  const fast = await routeTask({ provider: "codex", prompt: "현재 상태를 간단히 설명해 주세요.", config: DEFAULT_CONFIG });
  const routine = await routeTask({ provider: "codex", prompt: "README 오탈자 한 곳만 수정해 주세요.", config: DEFAULT_CONFIG });

  assert.equal(fast.tier, "fast");
  assert.equal(fast.model, "gpt-5.6-sol");
  assert.equal(fast.effort, "low");
  assert.equal(routine.tier, "routine");
  assert.equal(routine.model, "gpt-5.6-sol");
  assert.equal(routine.effort, "medium");
});

test("raises storage work to complex even below the score threshold", async () => {
  const routing = await routeTask({
    provider: "codex",
    prompt: "Lustre 저장소 상태를 확인해 주세요.",
    config: DEFAULT_CONFIG,
  });

  assert.equal(routing.score, 2);
  assert.equal(routing.tier, "complex");
  assert.equal(routing.model, "gpt-6-astra");
  assert.equal(routing.effort, "low");
});

test("requires an explicit supported provider", async () => {
  await assert.rejects(
    routeTask({ prompt: "간단한 상태 확인", config: DEFAULT_CONFIG }),
    /Unknown routing provider: \(missing\)/,
  );
  await assert.rejects(
    routeTask({ provider: "openrouter", prompt: "간단한 상태 확인", config: DEFAULT_CONFIG }),
    /Unknown routing provider: openrouter/,
  );
});

test("aborts issue enrichment at the shared deadline and still returns a routing decision", async () => {
  const calls = [];
  const routing = await routeTask({
    provider: "codex",
    prompt: "#1 장애 원인을 확인해 주세요.",
    config: { issue: { deadlineMs: 25, timeoutMs: 1_000 } },
    fetchIssue: async (_iid, options) => {
      calls.push(options);
      return new Promise(() => {});
    },
  });

  assert.equal(routing.contractVersion, 1);
  assert.equal(routing.issues.length, 0);
  assert.ok(routing.warnings.some((warning) => warning.includes("deadline")));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, path.resolve(process.cwd()));
  assert.equal(calls[0].signal.aborted, true);
});

test("rejects malformed v1 profiles and oversized UTF-8 prompts", async () => {
  await assert.rejects(
    routeTask({
      provider: "codex",
      prompt: "상태 확인",
      config: { profiles: { codex: { tiers: { fast: { model: "", effort: "low", label: "invalid" } } } } },
    }),
    /invalid model, effort, or label for tier: fast/,
  );

  const oversized = "가".repeat(Math.ceil(MAX_PROMPT_BYTES / Buffer.byteLength("가", "utf8")));
  await assert.rejects(
    routeTask({ provider: "codex", prompt: oversized, config: DEFAULT_CONFIG }),
    /UTF-8 bytes/,
  );
  await assert.rejects(
    routeTask({
      provider: "codex",
      prompt: "상태 확인",
      config: {
        profiles: {
          codex: {
            default: { model: "small", effort: "low", label: "small" },
            promoted: { model: "large", effort: "high", label: "large" },
            tiers: DEFAULT_CONFIG.profiles.codex.tiers,
          },
        },
      },
    }),
    /Legacy default\/promoted profiles are not supported by routing contract v1/,
  );
});

test("normalizes and validates the workspace path in the public response", async () => {
  const routing = await routeTask({
    provider: "codex",
    prompt: "상태를 확인해 주세요.",
    cwd: `${process.cwd()}/./`,
    config: DEFAULT_CONFIG,
  });

  assert.equal(routing.cwd, path.resolve(process.cwd()));
  validateRoutingResponse(routing, { expectedProvider: "codex" });
  assert.throws(
    () => validateRoutingResponse({ ...routing, provider: "claude" }, { expectedProvider: "codex" }),
    /provider.*does not match request/,
  );
  await assert.rejects(
    routeTask({ provider: "codex", prompt: "상태", cwd: path.join(process.cwd(), "missing-directory"), config: DEFAULT_CONFIG }),
    /cwd directory could not be accessed/,
  );
});

test("rejects extra root and raw issue fields at the v1 boundary", async () => {
  const routing = await routeTask({ provider: "codex", prompt: "상태", config: DEFAULT_CONFIG });

  assert.throws(
    () => validateRoutingResponse({ ...routing, internal: "secret" }),
    /root.*unknown field: internal/,
  );
  for (const field of ["text", "comments", "description", "body"]) {
    assert.throws(
      () => validateRoutingResponse({ ...routing, issues: [{ ...routing.issues[0], [field]: "secret" }] }),
      /issues\[\].*unknown field/,
    );
  }
});
