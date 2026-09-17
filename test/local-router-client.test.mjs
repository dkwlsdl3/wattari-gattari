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

test("router forwards actual CLI progress before completion with the extended judge budget", async () => {
  const { PassThrough } = await import("node:stream");
  const { runRouter } = await import("../src/local-router-client.mjs");
  const fixture = await fs.readFile(new URL("./fixtures/local-router-progress.txt", import.meta.url));
  const events = [];
  let finish;
  const stderr = new PassThrough();
  stderr.setEncoding("utf8"); // execFile uses decoded streams by default.
  const pending = new Promise(resolve => { finish = resolve; });
  pending.child = { stderr };
  const client = new LocalRouterClient({ dir: "/tmp/waga-proof-router",
    ensure: async () => ({ entry: "/tmp/router.mjs" }),
    run: (command, args, options) => runRouter(command, args, options, (_, __, opts) => {
      assert.equal(opts.timeout, 75_000);
      assert.equal(opts.env.WAGA_ROUTER_PROGRESS, "1");
      return pending;
    }),
  });
  const routed = client.route({ prompt: "hello", cwd: "/work/project", onProgress: event => events.push(event) });
  await new Promise(resolve => setImmediate(resolve));
  stderr.write(fixture);
  assert.equal(events.some(event => event.stage === "judge" && event.message.includes("Astra")), true);
  assert.equal(events.some(event => event.routing), false);
  finish({ stdout: JSON.stringify(routingFixture()) });
  assert.deepEqual(await routed, routingFixture());
  assert.deepEqual(events.at(-1).routing, routingFixture());
  stderr.end();
});

test("stderr progress handles split UTF-8, junk and oversized lines without leaking diagnostics", async () => {
  const { PassThrough } = await import("node:stream");
  const { readRouterProgress } = await import("../src/local-router-client.mjs");
  const stream = new PassThrough();
  const events = [];
  readRouterProgress(stream, event => events.push(event));
  const line = 'WAGA_ROUTER_PROGRESS '+JSON.stringify({ version: 1, stage: "judge", message: "판정 대기" })+'\n';
  for (const byte of Buffer.from(line)) stream.write(Buffer.from([byte]));
  stream.write('diagnostic secret\nWAGA_ROUTER_PROGRESS broken\n');
  stream.write('x'.repeat(5000));
  stream.write(line);
  stream.write('WAGA_ROUTER_PROGRESS '+JSON.stringify({version: 2, stage: "judge", message: "ignore"})+'\n');
  stream.write(line);
  stream.end();
  assert.deepEqual(events, Array(2).fill({ stage: "judge", message: "판정 대기" }));
});

test("failed router diagnostics exclude progress and retain timeout status", async () => {
  const client = new LocalRouterClient({ dir: "/tmp/waga-proof-router", ensure: async () => ({ entry: "/tmp/router.mjs" }),
    run: async () => { throw Object.assign(new Error("terminated"), { killed: true, stderr: 'WAGA_ROUTER_PROGRESS {"message":"old progress"}\n' }); },
  });
  await assert.rejects(client.route({ prompt: "hello" }), error => /75초/.test(error.message) && !error.message.includes("old progress"));
});

test('v2 CLI fixture accepts explicit issue context and streams cumulative public reason', async () => {
  const fixture = JSON.parse(await fs.readFile(new URL('./fixtures/local-router-v2.json', import.meta.url), 'utf8'));
  const client = new LocalRouterClient({ dir: '/tmp/waga-proof-router', ensure: async () => ({entry:'/tmp/router.mjs'}),
    run: async (_, __, options) => { assert.equal(options.env.WAGA_ROUTER_CONTEXT, '1'); return { stdout: JSON.stringify(fixture) }; },
  });
  assert.deepEqual(await client.route({ prompt: '#201 검토', cwd: fixture.cwd }), fixture);
  const { PassThrough } = await import('node:stream');
  const { readRouterProgress } = await import('../src/local-router-client.mjs');
  const input = new PassThrough();
  const seen = [];
  readRouterProgress(input, event => seen.push(event));
  input.end(await fs.readFile(new URL('./fixtures/local-router-stream.txt', import.meta.url)));
  assert.deepEqual(seen.filter(event => event.stage === 'judge-text').map(event => event.message), ['동시성 복구', '동시성 복구 검토 필요']);
});
