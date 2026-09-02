import assert from "node:assert/strict";
import test from "node:test";

import { TerminalInputDecoder } from "../src/terminal-input-decoder.mjs";

test("decodes a fragmented SGR mouse wheel sequence without leaking text", async () => {
  const decoder = new TerminalInputDecoder();
  let output = "";
  const wheels = [];
  decoder.on("data", (chunk) => { output += chunk.toString("utf8"); });
  decoder.on("wheel", (wheel) => { wheels.push(wheel); });

  decoder.write("\x1b");
  decoder.write("[<64;10;");
  decoder.write("10M");
  decoder.write("\x1b[<65;10;10M");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(output, "");
  assert.deepEqual(wheels, [{ direction: "up" }, { direction: "down" }]);
  decoder.destroy();
});

test("passes keyboard escape sequences and Unicode through unchanged", async () => {
  const decoder = new TerminalInputDecoder();
  let output = "";
  decoder.on("data", (chunk) => { output += chunk.toString("utf8"); });

  decoder.write("가😀");
  decoder.write("\x1b[D");
  decoder.write("나");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(output, "가😀\x1b[D나");
  decoder.destroy();
});

test("emits a standalone Escape key without readline's 500ms delay", async () => {
  const decoder = new TerminalInputDecoder();
  const startedAt = performance.now();
  const key = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Escape was not emitted within 100ms")), 100);
    decoder.on("keypress", (_text, value) => {
      clearTimeout(timeout);
      resolve({ value, elapsed: performance.now() - startedAt });
    });
    decoder.write("\x1b");
  });

  assert.equal(key.value.name, "escape");
  assert.ok(key.elapsed < 100, `Escape took ${key.elapsed}ms`);
  decoder.destroy();
});
