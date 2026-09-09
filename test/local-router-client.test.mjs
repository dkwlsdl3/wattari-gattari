import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalRouterClient, ensureLocalRouterProject } from "../src/local-router-client.mjs";

test("local router client ensures the project and forwards one JSON route request", async () => {
  const calls = [];
  const client = new LocalRouterClient({
    dir: "/tmp/waga-local-router-test",
    ensure: async ({ dir }) => ({ dir, entry: "/tmp/waga-local-router-test/src/cli.mjs", created: true }),
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: JSON.stringify({ provider: "codex", label: "large", model: "large", effort: "low" }) };
    },
  });

  const routing = await client.route({ provider: "codex", prompt: "#123 확인", cwd: "/work/project" });
  assert.deepEqual(routing, { provider: "codex", label: "large", model: "large", effort: "low", source: "local-llm-router" });
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

  const failed = new LocalRouterClient({
    dir: "/tmp/waga-local-router-test",
    ensure: async ({ dir }) => ({ dir, entry: "/tmp/router.mjs" }),
    run: async () => { throw Object.assign(new Error("401"), { stderr: "401 Unauthorized" }); },
  });
  await assert.rejects(failed.route({ prompt: "hello" }), /401 Unauthorized/);
});

test("missing router project is copied, while a nonempty directory is never overwritten", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "waga-router-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, "new-router");
  const created = await ensureLocalRouterProject({ dir: target });
  assert.equal(created.created, true);
  assert.equal(await fs.readFile(path.join(target, "src", "cli.mjs"), "utf8").then((value) => value.includes("routeTask")), true);

  const occupied = path.join(root, "occupied");
  await fs.mkdir(occupied);
  await fs.writeFile(path.join(occupied, "keep.txt"), "keep");
  await assert.rejects(ensureLocalRouterProject({ dir: occupied }), /덮어쓰지 않았습니다/);
  assert.equal(await fs.readFile(path.join(occupied, "keep.txt"), "utf8"), "keep");
});
