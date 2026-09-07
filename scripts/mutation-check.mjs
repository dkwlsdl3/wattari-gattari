#!/usr/bin/env node
// Targeted fault injection in a disposable copy; never edits the checkout.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [group, output] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(path.join(root, "test/mutation/cases.json")));
if (!manifest[group] || !output || !path.isAbsolute(output) || process.argv.length !== 4) {
  throw new Error(`Usage: node scripts/mutation-check.mjs <${Object.keys(manifest).join("|")}> <new-absolute-output-directory>`);
}
fs.mkdirSync(output, { recursive: false });
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-mutation-"));
const hashes = {};
const hashTree = (directory) => {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) hashTree(relative);
    else if (!relative.endsWith("-review.json")) hashes[relative] = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, relative))).digest("hex");
  }
};
for (const directory of ["src", "test", "scripts"]) hashTree(directory);
for (const name of ["package.json", "package-lock.json"]) hashes[name] = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, name))).digest("hex");
const configuration = manifest[group];
const args = ["--test", "--test-reporter=tap", "--test-timeout=4000", ...configuration.tests];
const report = { group, observedAt: new Date().toISOString(), node: process.version, method: "targeted source replacement, not exhaustive Stryker generation", command: [process.execPath, ...args], processTimeoutMs: 20000, hashes, results: [] };
async function run(name, testArgs = args) {
  return new Promise((resolve, reject) => {
    const log = fs.openSync(path.join(output, `${name}.tap`), "wx");
    const child = spawn(process.execPath, testArgs, {
      cwd: scratch, detached: true, stdio: ["ignore", log, log],
      env: { ...process.env, TMPDIR: path.join(scratch, "tmp"), XDG_STATE_HOME: path.join(scratch, "state") },
    });
    fs.closeSync(log);
    let timedOut = false;
    const killGroup = () => { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, report.processTimeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      killGroup();
      const text = fs.readFileSync(path.join(output, `${name}.tap`), "utf8");
      const count = Number(/^# tests (\d+)$/m.exec(text)?.[1] ?? 0);
      const status = timedOut ? "process-timeout" : /testTimeoutFailure/.test(text) ? "test-timeout"
        : /ERR_MODULE_NOT_FOUND|# SyntaxError:/.test(text) ? "runner-error"
          : code === 0 && count > 0 ? "survived" : count > 0 ? "killed" : "runner-error";
      resolve({ status, code, signal, tests: count });
    });
  });
}
try {
  for (const name of ["src", "test", "scripts", "package.json", "package-lock.json"]) fs.cpSync(path.join(root, name), path.join(scratch, name), { recursive: true });
  fs.symlinkSync(path.join(root, "node_modules"), path.join(scratch, "node_modules"), "dir");
  fs.mkdirSync(path.join(scratch, "tmp"));
  report.baseline = await run("baseline");
  if (report.baseline.status !== "survived") throw new Error(`Baseline failed: ${report.baseline.status}`);
  for (const mutation of configuration.mutations) {
    if (!/^[a-z0-9-]+$/.test(mutation.id) || !mutation.file.startsWith("src/") || mutation.file.split("/").includes("..")) throw new Error("Unsafe mutation target");
    const file = path.join(scratch, mutation.file);
    const original = fs.readFileSync(file, "utf8");
    if (original.split(mutation.from).length !== 2) throw new Error(`Mutation must match exactly once: ${mutation.id}`);
    try {
      fs.writeFileSync(file, original.replace(mutation.from, mutation.to));
      const syntax = spawnSync(process.execPath, ["--check", file], { encoding: "utf8", timeout: 5000 });
      const result = { id: mutation.id, file: mutation.file, ...(syntax.status === 0 ? await run(mutation.id) : { status: "runner-error", syntaxError: syntax.stderr }) };
      if (result.status === "survived") result.fullSuite = await run(`${mutation.id}-full`, args.slice(0, 3));
      report.results.push(result);
      process.stdout.write(`${group}/${mutation.id}: ${result.status}${result.fullSuite ? ` (full: ${result.fullSuite.status})` : ""}\n`);
    } finally { fs.writeFileSync(file, original); }
  }
  report.restoredBaseline = await run("restored-baseline");
  if (report.restoredBaseline.status !== "survived") throw new Error("Restored baseline failed");
  process.exitCode = report.results.some((result) => ["survived", "runner-error"].includes(result.status) && result.fullSuite?.status !== "killed") ? 1 : 0;
} finally {
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  // This exact directory was created by this process above.
  fs.rmSync(scratch, { recursive: true, force: true });
}
