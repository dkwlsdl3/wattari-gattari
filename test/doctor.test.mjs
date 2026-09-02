import assert from "node:assert/strict";
import test from "node:test";

import { runDoctor } from "../src/doctor.mjs";

test("doctor reports each native boundary", async () => {
  let text = "";
  const ok = async () => ({ ok: true, detail: "ready" });
  const result = await runDoctor({ output: { write(chunk) { text += chunk; } }, probes: { node: ok, codexCli: ok, claudeCli: ok, codexAgents: ok, codexDaemon: ok, claudeAgents: ok } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.checks.length, 6);
  assert.match(text, /Codex daemon/);
  assert.match(text, /Claude peer registry/);
});
