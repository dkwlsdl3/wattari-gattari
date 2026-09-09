import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalRouterClient, ensureLocalRouterProject } from "../src/local-router-client.mjs";

function routingFixture(overrides = {}) {
  return {
    contractVersion: 1,
    provider: "codex",
    model: "gpt-6-astra",
    effort: "low",
    label: "GPT-6 Astra · low",
    tier: "complex",
    score: 3,
    confidence: "high",
    skills: ["issue-loop"],
    reasons: ["issue-loop (+3)"],
    cwd: "/work/project",
    source: "local-llm-router",
    issueRefs: ["123"],
    issues: [{ iid: "123", title: "Example issue", labels: ["reliability"], commentCount: 2 }],
    warnings: [],
    ...overrides,
  };
}

test("local router accepts the checked-in v1 contract fixture", async () => {
  const fixture = JSON.parse(await fs.readFile(new URL("./fixtures/local-router-v1.json", import.meta.url), "utf8"));
  const client = new LocalRouterClient({
    dir: "/tmp/waga-local-router-test",
    ensure: async ({ dir }) => ({ dir, entry: "/tmp/router.mjs" }),
    run: async () => ({ stdout: JSON.stringify(fixture) }),
  });
  assert.deepEqual(await client.route({ provider: "codex", prompt: "hello", cwd: "/work/project" }), fixture);
});

test("local router client ensures the project and forwards one JSON route request", async () => {
  const calls = [];
  const client = new LocalRouterClient({
    dir: "/tmp/waga-local-router-test",
    ensure: async ({ dir }) => ({ dir, entry: "/tmp/waga-local-router-test/src/cli.mjs", created: true }),
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: JSON.stringify(routingFixture()) };
    },
  });

  const routing = await client.route({ provider: "codex", prompt: "#123 확인", cwd: "/work/project" });
  assert.deepEqual(routing, routingFixture());
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args.slice(1, 4), ["route", "--provider", "codex"]);
  assert.deepEqual(calls[0].args.slice(-1), ["--json"]);
  assert.equal(calls[0].options.cwd, "/work/project");
});

test("local router rejects malformed output and does not hide execution errors", async () => {
  const malformed = new LocalRouterClient({
    dir: "/tmp/waga-local-router-test",
    ensure: async ({ dir }) => ({ dir, entry: "/tmp/router.mjs" }),
    run: async () => ({ stdout: "not-json" }),
  });
  await assert.rejects(malformed.route({ prompt: "hello" }), /JSON을 반환하지 않았습니다/);

  const invalidSchema = new LocalRouterClient({
    dir: "/tmp/waga-local-router-test",
    ensure: async ({ dir }) => ({ dir, entry: "/tmp/router.mjs" }),
    run: async () => ({ stdout: JSON.stringify(routingFixture({ model: null })) }),
  });
  await assert.rejects(invalidSchema.route({ prompt: "hello", cwd: "/work/project" }), /model 필드/);

  const rawIssue = new LocalRouterClient({
    dir: "/tmp/waga-local-router-test",
    ensure: async ({ dir }) => ({ dir, entry: "/tmp/router.mjs" }),
    run: async () => ({ stdout: JSON.stringify(routingFixture({ issues: [{ iid: "1", title: "x", labels: [], commentCount: 0, text: "secret" }] })) }),
  });
  await assert.rejects(rawIssue.route({ prompt: "hello", cwd: "/work/project" }), /허용되지 않는 필드/);

  const hiddenIssueField = new LocalRouterClient({
    dir: "/tmp/waga-local-router-test",
    ensure: async ({ dir }) => ({ dir, entry: "/tmp/router.mjs" }),
    run: async () => ({ stdout: JSON.stringify(routingFixture({ issues: [{ iid: "1", title: "x", labels: [], commentCount: 0, description: "secret" }] })) }),
  });
  await assert.rejects(hiddenIssueField.route({ prompt: "hello", cwd: "/work/project" }), /허용되지 않는 필드/);

  const hiddenRootField = new LocalRouterClient({
    dir: "/tmp/waga-local-router-test",
    ensure: async ({ dir }) => ({ dir, entry: "/tmp/router.mjs" }),
    run: async () => ({ stdout: JSON.stringify(routingFixture({ secret: "secret" })) }),
  });
  await assert.rejects(hiddenRootField.route({ prompt: "hello", cwd: "/work/project" }), /허용되지 않는 필드/);

  const failed = new LocalRouterClient({
    dir: "/tmp/waga-local-router-test",
    ensure: async ({ dir }) => ({ dir, entry: "/tmp/router.mjs" }),
    run: async () => { throw Object.assign(new Error("401"), { stderr: "401 Unauthorized" }); },
  });
  await assert.rejects(failed.route({ prompt: "hello" }), /401 Unauthorized/);
});

test("local router enforces the request provider and prompt boundary", async () => {
  const client = new LocalRouterClient({
    dir: "/tmp/waga-local-router-test",
    ensure: async ({ dir }) => ({ dir, entry: "/tmp/router.mjs" }),
    run: async () => ({ stdout: JSON.stringify(routingFixture()) }),
  });
  await assert.rejects(client.route({ provider: "openrouter", prompt: "hello" }), /provider is unsupported/);
  await assert.rejects(client.route({ provider: "codex", prompt: "   " }), /prompt is required/);
  await assert.rejects(client.route({ provider: "codex", prompt: "x".repeat(128 * 1024 + 1) }), /UTF-8 bytes/);
});

test("local router rejects a response from the wrong working directory", async () => {
  const client = new LocalRouterClient({
    dir: "/tmp/waga-local-router-test",
    ensure: async ({ dir }) => ({ dir, entry: "/tmp/router.mjs" }),
    run: async () => ({ stdout: JSON.stringify(routingFixture({ cwd: "/work/other" })) }),
  });
  await assert.rejects(client.route({ prompt: "hello", cwd: "/work/project" }), /cwd/);
});

test("missing router project is copied, while a nonempty directory is never overwritten", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "waga-router-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "new-router");
  const created = await ensureLocalRouterProject({ dir: target });
  assert.equal(created.created, true);
  assert.equal(await fs.readFile(path.join(target, "src", "cli.mjs"), "utf8").then((value) => value.includes("routeTask")), true);
  assert.equal(await fs.readFile(path.join(target, "router.config.json"), "utf8").then((value) => value.includes('"critical"')), true);

  const occupied = path.join(root, "occupied");
  await fs.mkdir(occupied);
  await fs.writeFile(path.join(occupied, "keep.txt"), "keep");
  await assert.rejects(ensureLocalRouterProject({ dir: occupied }), /덮어쓰지 않았습니다/);
  assert.equal(await fs.readFile(path.join(occupied, "keep.txt"), "utf8"), "keep");
});
