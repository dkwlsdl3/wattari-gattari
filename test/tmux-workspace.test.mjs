import assert from "node:assert/strict";
import test from "node:test";

import {
  GLOBAL_DOCK_SESSION,
  TmuxWorkspace,
  shellCommand,
  workspaceSessionName,
} from "../src/tmux-workspace.mjs";

test("workspace session names are stable, readable, and tmux-safe", () => {
  const first = workspaceSessionName("/tmp/My Project");
  assert.match(first, /^waga-my-project-[0-9a-f]{8}$/);
  assert.equal(first, workspaceSessionName("/tmp/My Project"));
  assert.notEqual(first, workspaceSessionName("/tmp/Other Project"));
});

test("shellCommand safely quotes command arguments", () => {
  assert.equal(shellCommand("node", ["/tmp/a b.mjs", "it's", "$HOME"]), "exec 'node' '/tmp/a b.mjs' 'it'\\''s' '$HOME'");
});

test("enter uses switch-client instead of nesting when already inside tmux", async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "display-message") return { stdout: "work\n", stderr: "", code: 0 };
    if (args[0] === "has-session") return { stdout: "", stderr: "missing", code: 1 };
    return { stdout: "", stderr: "", code: 0 };
  };
  const workspace = new TmuxWorkspace({ run, launch: async () => { throw new Error("must not attach nested tmux"); }, env: { TMUX: "/tmp/tmux,1,0" }, cliPath: "/app/cli.mjs", nodePath: "/usr/bin/node" });
  assert.deepEqual(await workspace.enter({ cwd: "/tmp/project" }), { code: 0, mode: "existing" });
  const created = calls.find((args) => args[0] === "new-session");
  assert.ok(created);
  assert.ok(created.includes(GLOBAL_DOCK_SESSION));
  assert.doesNotMatch(created.at(-1), /--cwd/);
  assert.ok(calls.some((args) => args[0] === "switch-client"));
  assert.ok(!calls.flat().includes("attach-session"));
  assert.deepEqual(
    calls.filter((args) => args.includes("mouse")),
    [["set-option", "-t", GLOBAL_DOCK_SESSION, "mouse", "on"]],
    "Waga must enable tmux mouse handling only for its own session",
  );
  assert.ok(calls.some((args) => args.includes("status-right") && args.some((value) => value.includes("prefix+0"))));
  assert.ok(calls.some((args) => args.includes("status-style") && args.includes("bg=#0f172a,fg=#e2e8f0")));
});

test("explicit cwd creates a workspace-scoped dock and filter", async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args.includes("has-session")) return { stdout: "", stderr: "missing", code: 1 };
    return { stdout: "", stderr: "", code: 0 };
  };
  const workspace = new TmuxWorkspace({ run, launch: async () => ({ code: 0 }), env: {}, cliPath: "/app/cli.mjs", nodePath: "/usr/bin/node", socketName: "waga-test" });
  assert.deepEqual(await workspace.enter({ cwd: "/tmp/launch", filterCwd: "/tmp/project" }), { code: 0, mode: "isolated" });
  const created = calls.find((args) => args.includes("new-session"));
  assert.ok(created.includes(workspaceSessionName("/tmp/project")));
  assert.match(created.at(-1), /'overview' '--cwd' '\/tmp\/project'/);
});

test("enter attaches an isolated server when outside tmux", async () => {
  const calls = [];
  let launched;
  const run = async (args) => {
    calls.push(args);
    if (args.includes("has-session")) return { stdout: "", stderr: "missing", code: 1 };
    return { stdout: "", stderr: "", code: 0 };
  };
  const launch = async (args, options) => { launched = [args, options]; return { code: 3 }; };
  const workspace = new TmuxWorkspace({ run, launch, env: {}, cliPath: "/app/cli.mjs", nodePath: "/usr/bin/node", socketName: "waga-test" });
  assert.deepEqual(await workspace.enter({ cwd: "/tmp/project" }), { code: 3, mode: "isolated" });
  assert.ok(calls.some((args) => args.includes("new-session")));
  assert.ok(launched[0].includes("attach-session"));
  assert.equal(launched[1].stdio, "inherit");
});

test("enter respawns only a stale overview and preserves native session windows", async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args.includes("has-session")) return { stdout: "", stderr: "", code: 0 };
    if (args.includes("list-windows") && args.at(-1).includes("@waga_revision")) {
      return { stdout: "overview\told-revision\nCodex · 작업\t\n", stderr: "", code: 0 };
    }
    if (args.includes("list-windows") && args.at(-1) === "#{window_name}") {
      return { stdout: "overview\nCodex · 작업\n", stderr: "", code: 0 };
    }
    if (args.includes("list-windows")) return { stdout: "@0\n@1\n", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  };
  const workspace = new TmuxWorkspace({
    run,
    launch: async () => ({ code: 0 }),
    env: {},
    cliPath: "/app/cli.mjs",
    nodePath: "/usr/bin/node",
    socketName: "waga-test",
    revision: "new-revision",
  });

  await workspace.enter({ cwd: "/tmp/project" });

  const respawn = calls.find((args) => args.includes("respawn-window"));
  assert.ok(respawn);
  assert.ok(respawn.includes("-k"));
  assert.ok(respawn.includes(`${GLOBAL_DOCK_SESSION}:overview`));
  assert.match(respawn.at(-1), /'overview'/);
  assert.ok(calls.some((args) => args.includes("set-window-option") && args.includes("@waga_revision") && args.at(-1) === "new-revision"));
  assert.ok(!calls.some((args) => args.includes("kill-session") || args.includes("kill-window")));
});

test("enter reuses an overview whose code revision is current", async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args.includes("has-session")) return { stdout: "", stderr: "", code: 0 };
    if (args.includes("list-windows") && args.at(-1).includes("@waga_revision")) {
      return { stdout: "overview\tcurrent\t/tmp/project\n", stderr: "", code: 0 };
    }
    if (args.includes("list-windows")) return { stdout: "@0\n", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  };
  const workspace = new TmuxWorkspace({ run, launch: async () => ({ code: 0 }), env: {}, revision: "current", socketName: "waga-test" });

  await workspace.enter({ cwd: "/tmp/project" });

  assert.ok(!calls.some((args) => args.includes("respawn-window")));
});

test("enter respawns the overview when the launch workspace changes", async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args.includes("has-session")) return { stdout: "", stderr: "", code: 0 };
    if (args.includes("list-windows") && args.at(-1).includes("@waga_revision")) {
      return { stdout: "overview\tcurrent\t/tmp/old-project\n", stderr: "", code: 0 };
    }
    if (args.includes("list-windows")) return { stdout: "@0\n", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  };
  const workspace = new TmuxWorkspace({ run, launch: async () => ({ code: 0 }), env: {}, revision: "current", socketName: "waga-test" });

  await workspace.enter({ cwd: "/tmp/new-project" });

  assert.ok(calls.some((args) => args.includes("respawn-window") && args.includes("/tmp/new-project")));
  assert.ok(calls.some((args) => args.includes("set-window-option") && args.includes("@waga_cwd") && args.at(-1) === "/tmp/new-project"));
});

test("enter checks and replaces a stale overview from another window in the same Waga session", async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "display-message") return { stdout: `${GLOBAL_DOCK_SESSION}\n`, stderr: "", code: 0 };
    if (args.includes("has-session")) return { stdout: "", stderr: "", code: 0 };
    if (args.includes("list-windows") && args.at(-1).includes("@waga_revision")) {
      return { stdout: "overview\told\nCodex · 작업\t\n", stderr: "", code: 0 };
    }
    if (args.includes("list-windows")) return { stdout: "@0\n@1\n", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  };
  const workspace = new TmuxWorkspace({ run, env: { TMUX: "/tmp/tmux,1,1" }, revision: "new" });

  await workspace.enter({ cwd: "/tmp/project" });

  assert.ok(calls.some((args) => args.includes("respawn-window")));
  assert.ok(calls.some((args) => args[0] === "select-window" && args.includes(`${GLOBAL_DOCK_SESSION}:overview`)));
  assert.ok(!calls.some((args) => args[0] === "switch-client"));
});

test("enter reports a missing tmux binary as an unavailable dock", async () => {
  const workspace = new TmuxWorkspace({
    run: async () => ({ stdout: "", stderr: "tmux not found", code: 127 }),
    env: {},
  });
  await assert.rejects(workspace.enter({ cwd: "/tmp/project" }), { code: "TMUX_UNAVAILABLE" });
});

test("focusOrOpen reuses a mapped window and creates only missing views", async () => {
  const calls = [];
  let list = "@2\tcodex:known\n";
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "list-windows") return { stdout: list, stderr: "", code: 0 };
    if (args[0] === "new-window") { list += "@3\tclaude:new\n"; return { stdout: "@3\n", stderr: "", code: 0 }; }
    return { stdout: "", stderr: "", code: 0 };
  };
  const workspace = new TmuxWorkspace({ run, env: { TMUX: "/tmp/tmux,1,0", WAGA_TMUX_SESSION: "waga-project-deadbeef" } });
  assert.deepEqual(await workspace.focusOrOpen({ id: "codex:known" }, { command: "codex", args: [], cwd: "/tmp" }), { reused: true, windowId: "@2" });
  assert.deepEqual(await workspace.focusOrOpen({ id: "claude:new", provider: "claude", name: "Review", cwd: "/tmp" }, { command: "claude", args: ["attach", "12345678"], cwd: "/tmp" }), { reused: false, windowId: "@3" });
  assert.equal(calls.filter((args) => args[0] === "new-window").length, 1);
  assert.ok(calls.some((args) => args[0] === "set-window-option" && args.includes("@waga_session_id")));
  assert.ok(calls.some((args) => args[0] === "set-window-option" && args.includes("window-status-format") && args.at(-1) === ""));
  assert.ok(calls.some((args) => args[0] === "set-window-option" && args.includes("window-status-current-format") && args.at(-1).includes("#{window_name}")));
});

test("leave switches to the previous session inside tmux and detaches isolated clients", async () => {
  const existingCalls = [];
  const existing = new TmuxWorkspace({ run: async (args) => { existingCalls.push(args); return { stdout: "", stderr: "", code: 0 }; }, env: { TMUX: "yes", WAGA_TMUX_MODE: "existing" } });
  await existing.leave();
  assert.deepEqual(existingCalls[0], ["switch-client", "-l"]);

  const isolatedCalls = [];
  const isolated = new TmuxWorkspace({ run: async (args) => { isolatedCalls.push(args); return { stdout: "", stderr: "", code: 0 }; }, env: { TMUX: "yes", WAGA_TMUX_MODE: "isolated" } });
  await isolated.leave();
  assert.deepEqual(isolatedCalls[0], ["detach-client"]);
});
