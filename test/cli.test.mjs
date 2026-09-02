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
