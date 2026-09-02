import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runCli } from "../src/cli.mjs";

function capture() {
  const stream = new PassThrough();
  let text = "";
  stream.on("data", (chunk) => { text += chunk.toString("utf8"); });
  return { stream, text: () => text };
}

test("runs version and invalid argument paths without exiting the process", async () => {
  const stdout = capture();
  const stderr = capture();
  assert.equal(await runCli(["--version"], { stdout: stdout.stream, stderr: stderr.stream }), 0);
  assert.equal(stdout.text(), "0.3.0\n");
  assert.equal(await runCli(["unknown"], { stdout: stdout.stream, stderr: stderr.stream }), 2);
  assert.match(stderr.text(), /Unknown argument/);
});

test("routes doctor and TUI through explicit interfaces", async () => {
  const stdout = capture();
  let doctorCalls = 0;
  let consoleCalls = 0;
  assert.equal(await runCli(["doctor"], {
    stdout: stdout.stream,
    doctor: async ({ output }) => {
      doctorCalls += 1;
      output.write("OK doctor\n");
      return { exitCode: 0 };
    },
  }), 0);
  assert.equal(await runCli([], {
    stdout: stdout.stream,
    runConsole: async () => {
      consoleCalls += 1;
      return { exitCode: 0 };
    },
  }), 0);
  assert.equal(doctorCalls, 1);
  assert.equal(consoleCalls, 1);
});

test("peer commands use a reachable broker without touching daemon lifecycle", async () => {
  const stdout = capture();
  let ensureCalls = 0;
  const request = async (method) => {
    assert.equal(method, "list_agents");
    return [{ id: "codex:one", status: "idle", name: "one" }];
  };

  assert.equal(await runCli(["agents"], {
    stdout: stdout.stream,
    request,
    ensureDaemon: async () => { ensureCalls += 1; },
  }), 0);
  assert.equal(ensureCalls, 0);
  assert.equal(stdout.text(), "codex:one\tidle\tone\n");
});

test("peer commands start the daemon once only when the broker is absent", async () => {
  const stdout = capture();
  let requestCalls = 0;
  let ensureCalls = 0;
  const request = async (method) => {
    requestCalls += 1;
    if (requestCalls === 1) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    assert.equal(method, "ask_agent");
    return { reply: "answer" };
  };

  assert.equal(await runCli(["ask", "codex:one", "question"], {
    stdout: stdout.stream,
    request,
    ensureDaemon: async () => { ensureCalls += 1; },
  }), 0);
  assert.equal(requestCalls, 2);
  assert.equal(ensureCalls, 1);
  assert.equal(stdout.text(), "answer\n");
});
