import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { TmuxWorkspace, shellCommand } from "../src/tmux-workspace.mjs";

const execFileAsync = promisify(execFile);
const hasTmux = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

async function waitFor(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

test("real isolated tmux reuses, revives, and removes one retained session view", { skip: !hasTmux }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-tmux-"));
  const socketPath = path.join(root, "tmux.sock");
  const sessionName = "waga-proof-integration";
  const prefix = ["-S", socketPath, "-f", "/dev/null"];
  const call = async (args, { check = true } = {}) => {
    try {
      const result = await execFileAsync("tmux", [...prefix, ...args], { encoding: "utf8" });
      return { ...result, code: 0 };
    } catch (error) {
      const result = {
        stdout: String(error.stdout ?? ""),
        stderr: String(error.stderr ?? error.message ?? ""),
        code: Number.isInteger(error.code) ? error.code : 1,
      };
      if (check) throw error;
      return result;
    }
  };
  t.after(() => {
    spawnSync("tmux", [...prefix, "kill-server"], { stdio: "ignore" });
    fs.rmSync(root, { recursive: true, force: true });
  });

  await call([
    "new-session", "-d", "-s", sessionName, "-n", "overview", "-c", root,
    shellCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"]),
  ]);

  const workspace = new TmuxWorkspace({
    run: (args) => call(args, { check: false }),
    env: { WAGA_TMUX_MODE: "isolated", WAGA_TMUX_SESSION: sessionName },
    eventLog: { record() {} },
  });
  const session = {
    id: "codex:waga-proof-session",
    nativeId: "waga-proof-session",
    provider: "codex",
    name: "integration proof",
    cwd: root,
  };
  const command = (marker) => ({
    command: process.execPath,
    args: ["-e", `console.log(${JSON.stringify(marker)}); setInterval(() => {}, 1000)`],
    cwd: root,
  });

  const opened = await workspace.focusOrOpen(session, command("WAGA_PROOF_READY_ONE"));
  assert.equal(opened.reused, false);
  await waitFor(async () => (await call(["capture-pane", "-p", "-t", opened.windowId])).stdout.includes("WAGA_PROOF_READY_ONE"));

  const reused = await workspace.focusOrOpen(session, command("MUST_NOT_RESTART"));
  assert.deepEqual(reused, { reused: true, windowId: opened.windowId });
  assert.equal((await call(["list-windows", "-t", sessionName, "-F", "#{@waga_session_id}"])).stdout
    .split("\n").filter((id) => id === session.id).length, 1);

  await call(["set-window-option", "-t", opened.windowId, "remain-on-exit", "on"]);
  await call(["send-keys", "-t", opened.windowId, "C-c"]);
  await waitFor(async () => (await call(["display-message", "-p", "-t", opened.windowId, "#{pane_dead}"])).stdout.trim() === "1");

  const revived = await workspace.focusOrOpen(session, command("WAGA_PROOF_READY_TWO"));
  assert.deepEqual(revived, { reused: true, windowId: opened.windowId });
  await waitFor(async () => (await call(["capture-pane", "-p", "-t", opened.windowId])).stdout.includes("WAGA_PROOF_READY_TWO"));

  assert.deepEqual(await workspace.closeSessionView(session), { closed: true, windowId: opened.windowId });
  assert.equal((await call(["list-windows", "-t", sessionName, "-F", "#{window_name}"])).stdout.trim(), "overview");

  assert.deepEqual(await workspace.leave(), { closeOverview: true });
  assert.notEqual((await call(["has-session", "-t", sessionName], { check: false })).code, 0);
});
