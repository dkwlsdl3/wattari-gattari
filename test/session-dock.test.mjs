import assert from "node:assert/strict";
import test from "node:test";

import { enterDirectDock, enterSessionDock } from "../src/session-dock.mjs";

const base = {
  cwd: "/tmp/waga-proof-dock",
  filterCwd: null,
  bridge: {},
  inputStream: {},
  outputStream: {},
  errorOutput: {},
};

test("direct dock composes the overview with native detach guidance", async () => {
  const workspace = {};
  let seen;
  const result = await enterDirectDock({
    ...base,
    workspace,
    overview: async (options) => { seen = options; return 7; },
  });
  assert.deepEqual(result, { code: 7, mode: "direct" });
  assert.equal(seen.filterCwd, null);
  assert.equal(seen.defaultCwd, base.cwd);
  assert.equal(seen.bridge, base.bridge);
  assert.equal(seen.workspace, workspace);
  assert.match(seen.nativeHint, /Claude Ctrl\+Z/);
  assert.match(seen.nativeHint, /Codex Ctrl\+D/);
});

test("auto backend prefers tmux", async () => {
  let tmuxCalls = 0;
  const result = await enterSessionDock({
    ...base,
    backend: "auto",
    enterTmux: async () => { tmuxCalls += 1; return { code: 3, mode: "isolated" }; },
    enterDirect: async () => { throw new Error("direct must not run"); },
  });
  assert.equal(tmuxCalls, 1);
  assert.deepEqual(result, { code: 3, mode: "isolated" });
});

test("auto backend falls back only when tmux is unavailable", async () => {
  let directOptions;
  const result = await enterSessionDock({
    ...base,
    backend: "auto",
    enterTmux: async () => { throw Object.assign(new Error("missing"), { code: "TMUX_UNAVAILABLE" }); },
    enterDirect: async (options) => { directOptions = options; return { code: 0, mode: "direct" }; },
  });
  assert.equal(directOptions.filterCwd, null);
  assert.deepEqual(result, { code: 0, mode: "direct" });

  await assert.rejects(enterSessionDock({
    ...base,
    backend: "auto",
    enterTmux: async () => { throw Object.assign(new Error("broken"), { code: "TMUX_COMMAND_FAILED" }); },
    enterDirect: async () => ({ code: 0 }),
  }), { code: "TMUX_COMMAND_FAILED" });
});

test("explicit backend never probes the other adapter", async () => {
  const direct = await enterSessionDock({
    ...base,
    backend: "direct",
    enterTmux: async () => { throw new Error("tmux must not run"); },
    enterDirect: async () => ({ code: 4, mode: "direct" }),
  });
  assert.deepEqual(direct, { code: 4, mode: "direct" });

  await assert.rejects(enterSessionDock({
    ...base,
    backend: "tmux",
    enterTmux: async () => { throw Object.assign(new Error("missing"), { code: "TMUX_UNAVAILABLE" }); },
    enterDirect: async () => ({ code: 0 }),
  }), { code: "TMUX_UNAVAILABLE" });
});
