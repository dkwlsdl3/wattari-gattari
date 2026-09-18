import assert from "node:assert/strict";
import test from "node:test";

import { defaultDoctorProbes, runDoctor } from "../src/doctor.mjs";

test("doctor reports each native boundary", async () => {
  let text = "";
  const ok = async () => ({ ok: true, detail: "ready" });
  const result = await runDoctor({ output: { write(chunk) { text += chunk; } }, probes: { node: ok, tmux: ok, codexCli: ok, claudeCli: ok, codexAgents: ok, codexDaemon: ok, claudeAgents: ok } });
  assert.equal(result.exitCode, 0);
  assert.equal(result.checks.length, 7);
  assert.match(text, /tmux \(optional\)/);
  assert.match(text, /Codex daemon/);
  assert.match(text, /Claude peer registry/);
});

test("doctor continues after required probes fail or throw", async () => {
  const ok = async () => ({ ok: true, detail: "ok" });
  let last = false;
  const result = await runDoctor({ output: { write() {} }, probes: {
    node: ok, tmux: ok, codexCli: async () => { throw new Error("missing executable"); }, claudeCli: ok,
    codexAgents: ok, codexDaemon: async () => ({ ok: false }), claudeAgents: async () => { last = true; return { ok: true }; },
  } });
  assert.equal(result.exitCode, 1);
  assert.equal(result.checks.length, 7);
  assert.equal(result.checks[2].detail, "missing executable");
  assert.equal(result.checks[5].detail, "no detail");
  assert.equal(last, true);
});

test("doctor reports missing tmux without failing required checks", async () => {
  const ok = async () => ({ ok: true, detail: "ready" });
  const missing = async () => ({ ok: false, detail: "not found" });
  const result = await runDoctor({
    output: { write() {} },
    probes: { node: ok, tmux: missing, codexCli: ok, claudeCli: ok, codexAgents: ok, codexDaemon: ok, claudeAgents: ok },
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.checks.find((check) => check.name.startsWith("tmux")).required, false);
});

test("doctor reads a stopped Codex daemon as stopped and a missing CLI as broken", async () => {
  // codex exits non-zero with a connect error while the daemon is down; only a failed
  // spawn means the CLI itself is absent.
  const stopped = defaultDoctorProbes({ command: () => ({ ok: false, spawned: true, detail: "Error: failed to connect" }) });
  assert.deepEqual(await stopped.codexDaemon(), { ok: true, detail: "stopped" });
  const absent = defaultDoctorProbes({ command: () => ({ ok: false, spawned: false, detail: "not found" }) });
  assert.equal((await absent.codexDaemon()).ok, false);
  const running = defaultDoctorProbes({
    command: () => ({ ok: true, spawned: true, stdout: '{"status":"running","socketPath":"/tmp/codex.sock"}' }),
  });
  assert.deepEqual(await running.codexDaemon(), { ok: true, detail: "running at /tmp/codex.sock" });
});
