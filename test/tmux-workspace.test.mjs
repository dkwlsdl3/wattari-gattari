import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

import {
  retainedSessionName,
  TmuxWorkspace,
  shellCommand,
  workspaceSessionName,
} from "../src/tmux-workspace.mjs";

process.env.XDG_STATE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "waga-tmux-test-state-"));
const testStateDirectory = process.env.XDG_STATE_HOME;
after(() => fs.rmSync(testStateDirectory, { recursive: true, force: true }));

test("workspace session names are stable, readable, and tmux-safe", () => {
  const first = workspaceSessionName("/tmp/My Project");
  assert.match(first, /^waga-my-project-[0-9a-f]{8}$/);
  assert.equal(first, workspaceSessionName("/tmp/My Project"));
  assert.notEqual(first, workspaceSessionName("/tmp/Other Project"));
});

test("failed new-window setup rolls back only the newly created frontend", async () => {
  const calls = [];
  const workspace = new TmuxWorkspace({
    env: { WAGA_TMUX_SESSION: "waga-proof" }, eventLog: { record() {} },
    run: async (args) => {
      calls.push(args);
      if (args[0] === "list-windows") return { code: 0, stdout: "@1\tcodex:keep\t0\n", stderr: "" };
      if (args[0] === "new-window") return { code: 0, stdout: "@7\n", stderr: "" };
      if (args[0] === "set-window-option") return { code: 1, stdout: "", stderr: "metadata failed" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  await assert.rejects(workspace.focusOrOpen({ id: "codex:new", provider: "codex" }, { command: "fake", args: [], cwd: "/tmp" }), { code: "TMUX_COMMAND_FAILED" });
  assert.deepEqual(calls.filter(([command]) => command === "kill-window"), [["kill-window", "-t", "@7"]]);
  assert.equal(calls.some(([command]) => command === "select-window"), false);
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
  const viewName = created[created.indexOf("-s") + 1];
  assert.match(viewName, /^waga-view-/);
  assert.doesNotMatch(created.at(-1), /--cwd/);
  assert.ok(calls.some((args) => args[0] === "switch-client"));
  assert.ok(!calls.flat().includes("attach-session"));
  assert.deepEqual(
    calls.filter((args) => args.includes("mouse")),
    [["set-option", "-t", viewName, "mouse", "on"]],
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
  assert.match(created[created.indexOf("-s") + 1], /^waga-view-/);
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
  assert.ok(calls.some((args) => args.includes("status-right") && args.some((value) => value.includes("Alt+A agents · Alt+G dock"))));
  assert.ok(calls.some((args) => args.includes("bind-key") && args.includes("M-g") && args.at(-1) === "select-window -t :overview ; send-keys -t :overview M-r"));
  assert.ok(calls.some((args) => args.includes("bind-key") && args.includes("M-a") && args.some((value) => value.includes("tmux-agents-view") && value.includes("#{window_id}"))));
  assert.ok(launched[0].includes("attach-session"));
  assert.equal(launched[1].stdio, "inherit");
});

test("each entry gets a private overview without respawning an existing user's dock", async () => {
  const calls = [];
  const workspace = new TmuxWorkspace({
    run: async args => { calls.push(args); return { code: 0, stdout: "" }; },
    env: { TMUX: "existing-server" }, eventLog: { record() {} },
  });
  await workspace.enter({ cwd: "/tmp/project" });
  await workspace.enter({ cwd: "/tmp/other" });
  const created = calls.filter(args => args[0] === "new-session");
  const names = created.map(args => args[args.indexOf("-s") + 1]);
  assert.equal(new Set(names).size, 2);
  assert.ok(created.every(args => args.at(-1).includes("WAGA_TMUX_INDEPENDENT=1")));
  assert.deepEqual(calls.filter(args => args[0] === "switch-client").map(args => args.at(-1)), names);
  assert.ok(!calls.some(args => ["respawn-window", "kill-window", "kill-session"].includes(args[0])));
  assert.equal(calls.filter(args => args[0] === "set-hook" && args.includes("client-detached")).length, 2);
});

test("failed attachment cleans up only its private view", async () => {
  const calls = [];
  const workspace = new TmuxWorkspace({
    run: async args => { calls.push(args); return { code: 0, stdout: "" }; },
    launch: async () => { throw new Error("attachment failed"); }, env: {},
  });
  await assert.rejects(workspace.enter({ cwd: "/tmp/project" }), /attachment failed/);
  const created = calls.find(args => args.includes("new-session"));
  const name = created[created.indexOf("-s") + 1];
  assert.equal(calls.filter(args => args.includes("kill-session")).length, 1);
  assert.ok(calls.at(-1).includes(name));
});

test("enter reports a missing tmux binary as an unavailable dock", async () => {
  const workspace = new TmuxWorkspace({
    run: async () => ({ stdout: "", stderr: "tmux not found", code: 127 }),
    env: {},
  });
  await assert.rejects(workspace.enter({ cwd: "/tmp/project" }), { code: "TMUX_UNAVAILABLE" });
});

test("focusOrOpen reuses live mapped sessions and creates only missing views", async () => {
  const calls = [];
  let list = "@2\tcodex:known\t0\n@4\tclaude:known\t0\n";
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "list-windows") return { stdout: list, stderr: "", code: 0 };
    if (args[0] === "capture-pane") return { stdout: "ready\n", stderr: "", code: 0 };
    if (args[0] === "display-message" && args.at(-1) === "#{pane_title}") return { stdout: "01a07a2e-c4ce-75c1-9fb4-02192...\n", code: 0 };
    if (args[0] === "new-window") { list += "@3\tclaude:new\n"; return { stdout: "@3\n", stderr: "", code: 0 }; }
    return { stdout: "", stderr: "", code: 0 };
  };
  const workspace = new TmuxWorkspace({
    run,
    wait: async () => {},
    claudeViewMatches: async () => true,
    env: { TMUX: "/tmp/tmux,1,0", WAGA_TMUX_SESSION: "waga-project-deadbeef" },
    nodePath: "/usr/bin/node",
    sessionHostPath: "/app/native-session-host.mjs",
  });
  assert.deepEqual(await workspace.focusOrOpen({ id: "codex:known", nativeId: "01a07a2e-c4ce-75c1-9fb4-02192b587721" }, { command: "codex", args: [], cwd: "/tmp" }), { reused: true, windowId: "@2" });
  assert.deepEqual(await workspace.focusOrOpen({ id: "claude:known", provider: "claude", projectCwd: "/project" }, { command: "claude", args: ["attach", "known"], cwd: "/work" }), { reused: true, windowId: "@4" });
  assert.deepEqual(await workspace.focusOrOpen({ id: "claude:new", provider: "claude", name: "Review", cwd: "/tmp" }, { command: "claude", args: ["attach", "12345678"], cwd: "/tmp" }), { reused: false, windowId: "@3" });
  assert.equal(calls.filter((args) => args[0] === "new-window").length, 1);
  assert.deepEqual(calls.filter((args) => args[0] === "respawn-window"), []);
  assert.ok(calls.some((args) => args[0] === "set-window-option" && args.includes("@waga_provider") && args.at(-1) === "claude"));
  assert.ok(calls.some((args) => args[0] === "set-window-option" && args.includes("@waga_project_cwd") && args.at(-1) === "/project"));
  assert.ok(calls.some((args) => args[0] === "set-window-option" && args.includes("@waga_session_id")));
  assert.ok(calls.some((args) => args[0] === "set-window-option" && args.includes("window-status-format") && args.at(-1) === ""));
  assert.ok(calls.some((args) => args[0] === "set-window-option" && args.includes("window-status-current-format") && args.at(-1).includes("#{window_name}")));
});

test("native navigation from Claude session one to two cannot reuse session one's stale mapping", async () => {
  const calls = [];
  let visible = "session-two";
  const workspace = new TmuxWorkspace({
    env: { WAGA_TMUX_SESSION: "waga-proof-navigation" },
    eventLog: { record() {} }, wait: async () => {},
    claudeViewMatches: async (pid, command) => {
      assert.equal(pid, "100");
      assert.deepEqual(command.args, ["attach", "11111111"]);
      return false;
    },
    run: async (args) => {
      calls.push(args);
      if (args[0] === "list-windows") return { code: 0, stdout: "@4\tclaude:session-one\t0\n" };
      if (args[0] === "display-message") return { code: 0, stdout: "100\n" };
      if (args[0] === "respawn-window") {
        assert.match(args.at(-1), /'attach' '11111111'/);
        visible = "session-one";
      }
      return { code: 0, stdout: "ready\n" };
    },
  });
  await workspace.focusOrOpen({ id: "claude:session-one", provider: "claude" }, { command: "claude", args: ["attach", "11111111"], cwd: "/tmp" });
  assert.equal(visible, "session-one");
  assert.equal(calls.filter((args) => args[0] === "respawn-window").length, 1);
  assert.ok(calls.findLastIndex((args) => args[0] === "capture-pane") < calls.findLastIndex((args) => args[0] === "select-window"));
});

test("forced focusOrOpen keeps a reattached native view hidden until its frame settles", async () => {
  const calls = [];
  const frames = ["", ...Array(4).fill("loading\n"), ...Array(6).fill("ready\n")];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "list-windows") return { stdout: "@2\tcodex:known\t0\n", stderr: "", code: 0 };
    if (args[0] === "capture-pane") return { stdout: frames.shift() ?? "ready\n", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  };
  const workspace = new TmuxWorkspace({
    run,
    wait: async () => {},
    env: { TMUX: "/tmp/tmux,1,0", WAGA_TMUX_SESSION: "waga-project-deadbeef" },
    nodePath: "/usr/bin/node",
    sessionHostPath: "/app/native-session-host.mjs",
  });

  await workspace.focusOrOpen({ id: "codex:known" }, { command: "codex", args: [], cwd: "/tmp" }, { force: true });

  const respawnIndex = calls.findIndex((args) => args[0] === "respawn-window");
  const selectIndex = calls.findIndex((args) => args[0] === "select-window");
  const captures = calls.filter((args) => args[0] === "capture-pane");
  assert.equal(captures.length, 11);
  assert.ok(respawnIndex >= 0 && selectIndex > respawnIndex);
  assert.ok(calls.findIndex((args) => args[0] === "capture-pane") > respawnIndex);
  assert.ok(calls.findLastIndex((args) => args[0] === "capture-pane") < selectIndex);
});

test("focusOrOpen automatically reattaches a dead mapped view", async () => {
  const calls = [];
  const workspace = new TmuxWorkspace({
    run: async (args) => {
      calls.push(args);
      if (args[0] === "list-windows") return { stdout: "@2\tcodex:known\t1\n", stderr: "", code: 0 };
      if (args[0] === "capture-pane") return { stdout: "ready\n", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    },
    wait: async () => {},
    env: { TMUX: "yes", WAGA_TMUX_SESSION: "waga-global" },
    nodePath: "/usr/bin/node",
    sessionHostPath: "/app/native-session-host.mjs",
  });

  await workspace.focusOrOpen({ id: "codex:known", provider: "codex" }, { command: "codex", args: ["resume", "known"], cwd: "/tmp" });

  assert.equal(calls.filter((args) => args[0] === "respawn-window").length, 1);
});

test("Alt+A source metadata opens one retained provider Agents view", async () => {
  const calls = [];
  let agentsWindows = "";
  const workspace = new TmuxWorkspace({
    run: async (args) => {
      calls.push(args);
      if (args[0] === "show-options" && args.at(-1) === "@waga_provider") return { stdout: "codex\n", stderr: "", code: 0 };
      if (args[0] === "show-options" && args.at(-1) === "@waga_project_cwd") return { stdout: "/work/project\n", stderr: "", code: 0 };
      if (args[0] === "display-message") return { stdout: "waga-global\n", stderr: "", code: 0 };
      if (args[0] === "list-windows") return { stdout: agentsWindows, stderr: "", code: 0 };
      if (args[0] === "new-window") { agentsWindows = "@5\tcodex\t0\n"; return { stdout: "@5\n", stderr: "", code: 0 }; }
      return { stdout: "", stderr: "", code: 0 };
    },
    env: { TMUX: "yes" },
  });

  assert.deepEqual(await workspace.focusAgentsViewFromWindow("@2"), { reused: false, windowId: "@5" });
  assert.deepEqual(await workspace.focusAgentsViewFromWindow("@2"), { reused: true, windowId: "@5" });
  assert.equal(calls.filter((args) => args[0] === "new-window").length, 1);
  assert.ok(calls.some((args) => args[0] === "new-window" && args.at(-1).includes("'codex' 'agents' '-C' '/work/project'")));
});

test("closeSessionView removes only the window mapped to the archived session", async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "list-windows") return { stdout: "@2\tcodex:keep\n@4\tclaude:archive\n", stderr: "", code: 0 };
    return { stdout: "", stderr: "", code: 0 };
  };
  const workspace = new TmuxWorkspace({ run, env: { TMUX: "/tmp/tmux,1,0", WAGA_TMUX_SESSION: "waga-project-deadbeef" } });
  assert.deepEqual(await workspace.closeSessionView({ id: "claude:archive" }), { closed: true, windowId: "@4" });
  assert.deepEqual(calls.at(-1), ["kill-window", "-t", "@4"]);
  assert.equal(calls.some((args) => args.includes("@2") && args[0] === "kill-window"), false);
});

test("reconcileSessionViews closes only stale windows from healthy providers", async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "list-windows") {
      return {
        stdout: "@1\t\n@2\tclaude:active\n@3\tclaude:stale\n@4\tcodex:preserve\n@5\tother:unknown\n",
        stderr: "",
        code: 0,
      };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  const workspace = new TmuxWorkspace({ run, env: { TMUX: "yes", WAGA_TMUX_SESSION: "waga-project-deadbeef" } });

  assert.deepEqual(await workspace.reconcileSessionViews(
    [{ id: "claude:active", provider: "claude" }],
    { availableProviders: ["claude"] },
  ), { closed: ["claude:stale"] });
  assert.deepEqual(calls.filter((args) => args[0] === "kill-window"), [["kill-window", "-t", "@3"]]);
});

test("reconcileSessionViews records its reason before killing a stale window", async () => {
  const calls = [];
  const events = [];
  const workspace = new TmuxWorkspace({
    run: async (args) => {
      calls.push(args);
      if (args[0] === "list-windows") return { stdout: "@3\tcodex:missing\n", stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    },
    env: { TMUX: "yes", WAGA_TMUX_SESSION: "waga-global" },
    eventLog: { record(event, details) { events.push([event, details]); } },
  });

  await workspace.reconcileSessionViews([], { availableProviders: ["codex"] });

  const killIndex = calls.findIndex((args) => args[0] === "kill-window");
  assert.ok(killIndex >= 0);
  assert.deepEqual(events[0], ["session_view_close_requested", {
    sessionId: "codex:missing",
    windowId: "@3",
    reason: "provider_missing_from_loaded_set",
  }]);
  assert.deepEqual(events[1], ["session_view_closed", {
    sessionId: "codex:missing",
    windowId: "@3",
    reason: "provider_missing_from_loaded_set",
  }]);
});

test("shouldRefreshOverview reports whether the dock is attached and selected", async () => {
  for (const [stdout, expected] of [["1\t1\n", true], ["0\t1\n", false], ["1\t0\n", false]]) {
    const calls = [];
    const workspace = new TmuxWorkspace({
      run: async (args) => { calls.push(args); return { stdout, stderr: "", code: 0 }; },
      env: { TMUX: "yes", WAGA_TMUX_SESSION: "waga-project-deadbeef" },
    });
    assert.equal(await workspace.shouldRefreshOverview(), expected);
    assert.deepEqual(calls[0], ["display-message", "-p", "-t", "waga-project-deadbeef:overview", "#{window_active}\t#{session_attached}"]);
  }
});

test("leave switches or detaches clients and then destroys the Waga frontend session", async () => {
  const existingCalls = [];
  const existing = new TmuxWorkspace({ run: async (args) => { existingCalls.push(args); return { stdout: "", stderr: "", code: 0 }; }, env: { TMUX: "yes", WAGA_TMUX_MODE: "existing", WAGA_TMUX_SESSION: "waga-global" } });
  assert.deepEqual(await existing.leave(), { closeOverview: true });
  assert.deepEqual(existingCalls, [["switch-client", "-l"], ["kill-session", "-t", "waga-global"]]);

  const isolatedCalls = [];
  const isolated = new TmuxWorkspace({ run: async (args) => { isolatedCalls.push(args); return { stdout: "", stderr: "", code: 0 }; }, env: { TMUX: "yes", WAGA_TMUX_MODE: "isolated", WAGA_TMUX_SESSION: "waga-project-deadbeef" } });
  assert.deepEqual(await isolated.leave(), { closeOverview: true });
  assert.deepEqual(isolatedCalls.map((args) => args.slice(0, 2)), [["detach-client", "-E"], ["kill-session", "-t"]]);
  assert.match(isolatedCalls[0][2], /Waga frontend를 종료했습니다/);
  assert.match(isolatedCalls[0][2], /세션과 로그는 유지됩니다/);
  assert.equal(isolatedCalls[1][2], "waga-project-deadbeef");
});

// Stateful boundary: windows are shared, current-window belongs to each session.
function sharedTmux() {
  const sessions = new Map([
    ["waga-view-left", { windows: ["@0"], current: "@0" }],
    ["waga-view-right", { windows: ["@1"], current: "@1" }],
  ]);
  const windows = new Map();
  const calls = [];
  let next = 2;
  const run = async args => {
    calls.push(args);
    const value = flag => args[args.indexOf(flag) + 1];
    const target = value("-t");
    const ok = stdout => ({ code: 0, stdout: stdout ?? "", stderr: "" });
    switch (args[0]) {
      case "list-windows": {
        const session = sessions.get(target);
        if (!session) return { code: 1, stdout: "", stderr: "session missing" };
        return ok(session.windows.map(id => args.at(-1).includes("@waga_session_id")
          ? `${id}\t${windows.get(id)?.id ?? ""}\t0` : id).join("\n") + "\n");
      }
      case "new-session": {
        const name = value("-s");
        if (sessions.has(name)) return { code: 1, stdout: "", stderr: "duplicate session" };
        const id = `@${next++}`;
        sessions.set(name, { windows: [id], current: id });
        windows.set(id, { id: "" });
        return ok(id + "\n");
      }
      case "set-window-option":
        if (args.at(-2) === "@waga_session_id") windows.get(target).id = args.at(-1);
        return ok();
      case "link-window":
        sessions.get(target.slice(0, -1)).windows.push(value("-s"));
        return ok();
      case "select-window": {
        const [name, id] = target.split(":");
        assert.ok(sessions.get(name)?.windows.includes(id), `invalid window target ${target}`);
        sessions.get(name).current = id;
        return ok();
      }
      case "kill-session": sessions.delete(target); return ok();
      case "capture-pane": return ok("ready\n");
      case "display-message": return ok(args.at(-1) === "#{window_active_clients}" ? "0\n" : "100\n");
      case "list-clients": return ok("/dev/pts/proof\n");
      default: return ok();
    }
  };
  const workspace = name => new TmuxWorkspace({ run,
    env: { WAGA_TMUX_SESSION: name, WAGA_TMUX_INDEPENDENT: "1" },
    eventLog: { record() {} }, wait: async () => {}, claudeViewMatches: async () => true,
  });
  return { run, calls, sessions, windows, workspace };
}
const sharedSession = { id: "claude:proof", provider: "claude", name: "waga-proof-shared" };
const sharedCommand = { command: "fake-claude", args: ["attach", "proof"], cwd: "/tmp" };

test("independent navigation and closing a view preserve the other view and retained frontend", async () => {
  const model = sharedTmux();
  const left = model.workspace("waga-view-left");
  const right = model.workspace("waga-view-right");
  const first = await left.focusOrOpen(sharedSession, sharedCommand);
  assert.equal(model.sessions.get("waga-view-right").current, "@1");
  const second = await right.focusOrOpen(sharedSession, sharedCommand);
  assert.equal(second.windowId, first.windowId);
  assert.equal(second.reused, true);
  const other = await left.focusOrOpen({ ...sharedSession, id: "claude:other" }, sharedCommand);
  assert.equal(model.sessions.get("waga-view-left").current, other.windowId);
  assert.equal(model.sessions.get("waga-view-right").current, first.windowId);
  await left.leave();
  assert.equal(model.sessions.has("waga-view-left"), false);
  assert.equal(model.sessions.get("waga-view-right").current, first.windowId);
  assert.ok(model.sessions.has(retainedSessionName(sharedSession.id)));
  assert.ok(!model.calls.some(args => ["respawn-window", "kill-window"].includes(args[0])));
  assert.ok(model.calls.some(args => args[0] === "detach-client" && args.includes("/dev/pts/proof")));
});

test("simultaneous openers share one frontend even before its mapping is published", async () => {
  const model = sharedTmux();
  const results = await Promise.all([
    model.workspace("waga-view-left").focusOrOpen(sharedSession, sharedCommand),
    model.workspace("waga-view-right").focusOrOpen(sharedSession, sharedCommand),
  ]);
  assert.equal(results[0].windowId, results[1].windowId);
  assert.equal(model.windows.size, 1);
  assert.equal(results.filter(result => !result.reused).length, 1);
  assert.equal(model.calls.filter(args => args[0] === "respawn-window").length, 0);
});

test("visible shared frontend cannot be respawned from another view", async () => {
  const model = sharedTmux();
  await model.workspace("waga-view-left").focusOrOpen(sharedSession, sharedCommand);
  const workspace = new TmuxWorkspace({
    env: { WAGA_TMUX_SESSION: "waga-view-right", WAGA_TMUX_INDEPENDENT: "1" },
    run: args => args[0] === "display-message" ? { code: 0, stdout: "1\n" } : model.run(args),
  });
  await assert.rejects(workspace.focusOrOpen(sharedSession, sharedCommand, { force: true }), { code: "TMUX_VIEW_IN_USE" });
  assert.ok(!model.calls.some(args => args[0] === "respawn-window"));
});

test("Alt+A explicitly targets the calling session even when the source window has several links", async () => {
  const calls = [];
  const workspace = new TmuxWorkspace({ run: async args => {
    calls.push(args);
    if (args[0] === "show-options") return { code: 0, stdout: args.at(-1) === "@waga_provider" ? "codex\n" : "/tmp\n" };
    if (args[0] === "list-windows") return { code: 0, stdout: "@8\tcodex\t0\n" };
    return { code: 0, stdout: "" };
  } });
  await workspace.focusAgentsViewFromWindow("@2", "$7");
  assert.deepEqual(calls.at(-1), ["select-window", "-t", "$7:@8"]);
  assert.ok(!calls.some(args => args[0] === "display-message"));
  await assert.rejects(workspace.focusAgentsViewFromWindow("@2", "other:window"), { code: "TMUX_SESSION_UNAVAILABLE" });
});

test("a shared frontend navigated to another native session is not mislabeled or killed", async () => {
  const model = sharedTmux();
  await model.workspace("waga-view-left").focusOrOpen(sharedSession, sharedCommand);
  const workspace = new TmuxWorkspace({
    env: { WAGA_TMUX_SESSION: "waga-view-right", WAGA_TMUX_INDEPENDENT: "1" },
    claudeViewMatches: async () => false,
    run: args => args[0] === "display-message" ? { code: 0, stdout: "1\n" } : model.run(args),
  });
  await assert.rejects(workspace.focusOrOpen(sharedSession, sharedCommand), { code: "TMUX_VIEW_IN_USE" });
  assert.equal(model.sessions.get("waga-view-right").current, "@1");
  assert.ok(!model.calls.some(args => args[0] === "respawn-window"));
});

test("dead shared view revival does not kill a concurrent opener's live frontend", async () => {
  const calls = [];
  const workspace = new TmuxWorkspace({
    env: { WAGA_TMUX_SESSION: "waga-view-right", WAGA_TMUX_INDEPENDENT: "1" },
    eventLog: { record() {} },
    run: async args => {
      calls.push(args);
      if (args[0] === "list-windows") return { code: 0, stdout: args.at(-1).includes("@waga_session_id") ? "@4\tclaude:proof\t1\n" : "@4\n" };
      if (args[0] === "respawn-window") return { code: 1, stdout: "", stderr: "pane is still active" };
      if (args[0] === "display-message") return { code: 0, stdout: "0\n" };
      return { code: 0, stdout: "" };
    },
  });
  assert.deepEqual(await workspace.focusOrOpen(sharedSession, sharedCommand), { reused: true, windowId: "@4" });
  assert.ok(!calls.find(args => args[0] === "respawn-window").includes("-k"));
  assert.deepEqual(calls.at(-1), ["select-window", "-t", "waga-view-right:@4"]);
});

test("shared Codex is selected before waiting for its startup frame", async () => {
  const model = sharedTmux();
  await model.workspace("waga-view-left").focusOrOpen({ id: "codex:colour-proof", provider: "codex" }, { command: "fake", args: [], cwd: "/tmp" });
  const create = model.calls.find(args => args[0] === "new-session");
  assert.match(create.at(-1), /WAGA_WAIT_FOR_VISIBLE=1/);
  assert.ok(model.calls.findIndex(args => args[0] === "select-window") < model.calls.findIndex(args => args[0] === "capture-pane"));
});
