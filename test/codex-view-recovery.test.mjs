import assert from "node:assert/strict";
import test from "node:test";
import { TmuxWorkspace } from "../src/tmux-workspace.mjs";

const one = "01a07a2e-c4ce-75c1-9fb4-02192b587721";
const two = "01a07a2e-cabf-7fe0-84f7-f4557a6be9a4";
const marker = id => `${id.slice(0, 29)}...`;
// Same captured Codex header as codex-view.test.mjs; query failures are injected.
const chat = "╭────────────────────────────────────────────────────╮\n│ >_ OpenAI Codex (v0.153.2)                         │\n";

function fixture(overrides = {}) {
  const state = { title: marker(one), frame: chat, titleCode: 0, frameCode: 0, visible: 0, dead: false, ...overrides };
  const calls = [], events = [];
  const workspace = new TmuxWorkspace({
    env: { WAGA_TMUX_SESSION: "waga-proof-recovery", WAGA_TMUX_INDEPENDENT: "1" },
    eventLog: { record: (event, details) => events.push({ event, ...details }) },
    wait: async () => {},
    run: async args => {
      calls.push(args);
      if (args[0] === "list-windows") return { code: 0, stdout: args.at(-1) === "#{window_id}" ? "@60\n" : `@60\tcodex:${one}\t${Number(state.dead)}\n` };
      if (args[0] === "display-message" && args.at(-1) === "#{window_active_clients}") return { code: 0, stdout: `${state.visible}\n` };
      if (args[0] === "display-message" && args.at(-1) === "#{pane_title}") return { code: state.titleCode, stdout: state.title };
      if (args[0] === "capture-pane") return { code: state.frameCode, stdout: state.frame };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  return {
    state, calls, events,
    open: (options = {}) => workspace.focusOrOpen(
      { id: `codex:${one}`, nativeId: one, provider: "codex" },
      { command: "codex", args: ["resume", one], cwd: "/tmp/waga-proof-recovery" },
      { knownNativeIds: [one, two], ...options },
    ),
    respawns: () => calls.filter(args => args[0] === "respawn-window"),
  };
}

for (const [name, state] of Object.entries({
  "missing title": { title: "" },
  "unrecognized title": { title: "Codex" },
  "failed title query": { titleCode: 1 },
  "failed frame query": { frameCode: 1 },
  "empty frame": { frame: "" },
})) {
  test(`opening a live Codex view with ${name} preserves recovery across repeated selections`, async () => {
    const f = fixture(state);
    for (let i = 0; i < 4; i++) await f.open();
    assert.equal(f.respawns().length, 0);
    assert.equal(f.calls.filter(args => args[0] === "select-window").length, 4);
    const checks = f.events.filter(event => event.event === "session_view_identity_checked");
    assert.equal(checks.length, 4);
    assert.ok(checks.every(event => event.viewState === "unknown"));
    assert.equal(checks[0].titleQueryCode, f.state.titleCode);
    assert.equal(checks[0].frameQueryCode, f.state.frameCode);
    f.state.title = marker(one); f.state.frame = chat;
    f.state.titleCode = 0; f.state.frameCode = 0;
    await f.open();
    assert.equal(f.respawns().length, 0);
  });
}

test("confirmed Codex navigation still resumes the requested thread", async () => {
  for (const [state, options] of [
    [{ title: two }, {}],
    [{ title: marker(two) }, {}],
    // A thread opened inside Codex is not in knownNativeIds yet.
    [{ title: marker(two) }, { knownNativeIds: [one] }],
    [{ frame: "  Agent command center\n" }, {}],
  ]) {
    const f = fixture(state);
    await f.open(options);
    assert.equal(f.respawns().length, 1);
    assert.ok(f.respawns()[0].includes("-k"));
    assert.ok(f.respawns()[0].at(-1).includes(`'resume' '${one}'`));
  }
});

test("failed queries and ambiguous prefixes cannot turn partial evidence into a forced restart", async () => {
  for (const state of [{ title: two, frameCode: 1 }, { titleCode: 1, frame: "Agent command center\n" }]) {
    const f = fixture(state);
    await f.open();
    assert.equal(f.respawns().length, 0);
  }
  const f = fixture();
  await f.open({ knownNativeIds: [one, `${one.slice(0, 29)}0000000`] });
  assert.equal(f.respawns().length, 0);
});

test("unknown Codex identity does not prevent explicit recovery or revive a dead view incorrectly", async () => {
  const forced = fixture({ title: "" });
  await forced.open({ force: true });
  assert.equal(forced.respawns().length, 1);
  assert.ok(forced.respawns()[0].includes("-k"));
  const dead = fixture({ dead: true, title: "" });
  await dead.open();
  assert.equal(dead.respawns().length, 1);
  assert.ok(!dead.respawns()[0].includes("-k"));
});

test("confirmed navigation and explicit recovery preserve another terminal's visible frontend", async () => {
  for (const options of [{}, { force: true }]) {
    const f = fixture({ visible: 1, title: two });
    await assert.rejects(f.open(options), { code: "TMUX_VIEW_IN_USE" });
    assert.equal(f.respawns().length, 0);
  }
});
