import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { TmuxWorkspace } from "../src/tmux-workspace.mjs";

const host = fileURLToPath(new URL("../src/native-session-host.mjs", import.meta.url));
for (const signal of ["SIGTERM", "SIGHUP"]) {
  test(`real native host forwards ${signal} and preserves the child exit code`, { timeout: 5000 }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-native-"));
    const code = `process.on(${JSON.stringify(signal)}, () => process.exit(23)); console.log('READY'); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, [host, "codex", "codex:waga-proof", "--", process.execPath, "-e", code], {
      cwd: root, detached: true, env: { ...process.env, XDG_STATE_HOME: root }, stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("close", (status, exitSignal) => resolve({ status, exitSignal })); });
    t.after(async () => {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      await exited;
      fs.rmSync(root, { recursive: true, force: true });
    });
    await new Promise((resolve, reject) => {
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; if (output.includes("READY")) resolve(); });
      child.once("exit", () => reject(new Error("host exited before readiness")));
    });
    child.kill(signal);
    assert.deepEqual(await exited, { status: 23, exitSignal: null });
    const events = fs.readFileSync(path.join(root, "wattari-gattari", "events.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(events.map(({ event }) => event), ["native_session_started", "native_session_host_signal", "native_session_exited"]);
    assert.equal(events[1].signal, signal);
    assert.equal(events[2].code, 23);
    assert.ok(events.every((event) => event.sessionId === "codex:waga-proof"));
  });
}

test("native host CLI rejects malformed argv and reports a missing executable", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-host-errors-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (args) => promisify(execFile)(process.execPath, [host, ...args], { env: { ...process.env, XDG_STATE_HOME: root }, timeout: 3000 });
  await assert.rejects(run(["unknown"]), (error) => error.code === 1 && error.stderr.includes("INVALID_ARGUMENT"));
  await assert.rejects(run(["claude", "claude:proof", "--", path.join(root, "missing")]), (error) => error.code === 1 && error.stderr.includes("ENOENT"));
});

test("tmux control commands have a hard process deadline", { timeout: 8000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-tmux-timeout-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "tmux"), `#!${process.execPath}\nsetTimeout(() => process.exit(99), 6500);\n`, { mode: 0o700 });
  const workspace = new TmuxWorkspace({ env: { ...process.env, PATH: root, TMUX: "" }, eventLog: { record() {} } });
  await assert.rejects(workspace.enter({ cwd: root }), (error) => error.killed === true && error.signal === "SIGKILL");
});
