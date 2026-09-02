import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { openNativeAgents } from "../src/native-launcher.mjs";

test("native launcher delegates to provider-owned Agents TUIs", async () => {
  const calls = [];
  const launch = async (...args) => { calls.push(args); return { code: 0 }; };
  await openNativeAgents("claude", { cwd: "/tmp", launch });
  await openNativeAgents("codex", { cwd: "/tmp", launch });
  assert.deepEqual(calls[0].slice(0, 2), ["claude", ["agents", "--cwd", path.resolve("/tmp")]]);
  assert.deepEqual(calls[1].slice(0, 2), ["codex", ["agents", "-C", path.resolve("/tmp")]]);
});
