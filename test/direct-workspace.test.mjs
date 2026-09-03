import assert from "node:assert/strict";
import test from "node:test";

import { DirectWorkspace } from "../src/direct-workspace.mjs";

function terminalStream() {
  const events = [];
  return {
    events,
    isTTY: true,
    pause() { events.push("pause"); },
    resume() { events.push("resume"); },
    setRawMode(value) { events.push(`raw:${value}`); },
    write(value) { events.push(value); },
  };
}

test("direct workspace lends the terminal to the native TUI and restores it", async () => {
  const input = terminalStream();
  const output = terminalStream();
  let launched;
  const workspace = new DirectWorkspace({
    inputStream: input,
    outputStream: output,
    errorOutput: output,
    launch: async (command, args, options) => {
      launched = { command, args, options };
      assert.deepEqual(input.events, ["raw:false", "pause"]);
      return { code: 0, signal: null };
    },
  });

  const result = await workspace.focusOrOpen(
    { id: "claude:proof" },
    { command: "claude", args: ["attach", "proof"], cwd: "/tmp/waga-proof-direct" },
  );

  assert.deepEqual(result, { reused: false, code: 0, signal: null });
  assert.deepEqual(launched, {
    command: "claude",
    args: ["attach", "proof"],
    options: { cwd: "/tmp/waga-proof-direct", env: process.env, inputStream: input, outputStream: output, errorOutput: output },
  });
  assert.deepEqual(input.events, ["raw:false", "pause", "raw:true", "resume"]);
  assert.match(output.events[0], /\?1049l/);
  assert.match(output.events.at(-1), /\?1049h/);
});

test("direct workspace restores the terminal when native launch fails", async () => {
  const input = terminalStream();
  const output = terminalStream();
  const workspace = new DirectWorkspace({
    inputStream: input,
    outputStream: output,
    launch: async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
  });

  await assert.rejects(
    workspace.focusOrOpen({}, { command: "missing", args: [], cwd: "/tmp/waga-proof-direct" }),
    { code: "ENOENT" },
  );
  assert.deepEqual(input.events, ["raw:false", "pause", "raw:true", "resume"]);
  assert.match(output.events.at(-1), /\?1049h/);
});

test("direct workspace closes its overview instead of switching a multiplexer", async () => {
  const workspace = new DirectWorkspace({ inputStream: terminalStream(), outputStream: terminalStream() });
  assert.deepEqual(await workspace.leave(), { closeOverview: true });
});
