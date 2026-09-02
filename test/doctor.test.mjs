import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runDoctor } from "../src/doctor.mjs";

function probes(overrides = {}) {
  const ok = async () => ({ ok: true, detail: "ready" });
  return {
    node: ok,
    codexCli: ok,
    claudeCli: ok,
    runtimeDirectory: ok,
    stateDirectory: ok,
    daemon: ok,
    codexAppServer: ok,
    claudeAgents: ok,
    ...overrides,
  };
}

test("reports every runtime contract through one doctor interface", async () => {
  const output = new PassThrough();
  let text = "";
  output.on("data", (chunk) => { text += chunk.toString("utf8"); });
  const result = await runDoctor({ output, probes: probes() });
  assert.equal(result.exitCode, 0);
  assert.equal(result.checks.length, 8);
  assert.match(text, /OK  Codex App Server: ready/);
  assert.match(text, /OK  Claude agents JSON: ready/);
});

test("fails when a provider contract probe fails", async () => {
  const output = new PassThrough();
  const result = await runDoctor({
    output,
    probes: probes({ codexAppServer: async () => ({ ok: false, detail: "contract drift" }) }),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.checks.find((check) => check.name === "Codex App Server").ok, false);
});
