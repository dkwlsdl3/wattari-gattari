import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { RunStore, validateRun } from "../src/run-store.mjs";
import { guardedProcess, runWorkflow } from "../src/workflow-runtime.mjs";
import { startWebServer } from "../src/web-server.mjs";
const exec = promisify(execFile), wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const manifest = { title: "독립 작업과 의존 작업", includeContent: true, models: { edit: "haiku", verify: "haiku" }, nodes: [
  { id: "a", title: "A 수정", role: "edit", prompt: "A returns 2", outputs: ["a.mjs"], check: [process.execPath, "check.mjs", "a", "2"] },
  { id: "b", title: "B 수정", role: "edit", prompt: "B returns 3", outputs: ["b.mjs"], check: [process.execPath, "check.mjs", "b", "3"] },
  { id: "join", title: "A 산출물 확인", role: "scan", prompt: "Verify A returns 2", inputs: [{ from: "a", path: "a.mjs" }], check: [process.execPath, "check.mjs", "a", "2"] },
] };
async function fixture(t, spec = manifest) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "waga-proof-runtime-test-")), repo = path.join(root, "repo");
  await fs.mkdir(repo); await fs.writeFile(path.join(repo, "a.mjs"), "export default 0;\n"); await fs.writeFile(path.join(repo, "b.mjs"), "export default 0;\n");
  await fs.writeFile(path.join(repo, "check.mjs"), 'import assert from "node:assert/strict"; const {default:value}=await import(`./${process.argv[2]}.mjs`); assert.equal(value,Number(process.argv[3])); console.log("CHECK_OK");');
  await exec("git", ["init", "-q", repo]); await exec("git", ["-C", repo, "add", "."]); await exec("git", ["-C", repo, "-c", "user.name=waga-proof", "-c", "user.email=proof@example.invalid", "commit", "-qm", "fixture"]);
  const file = path.join(root, "workflow.json"); await fs.writeFile(file, JSON.stringify(spec));
  const store = new RunStore(path.join(root, "runs"));
  const web = await startWebServer({ bridge: { discover: async () => ({ sessions: [], warnings: [] }) }, cwd: repo, port: 0, runStore: store });
  t.after(async () => { await web.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, repo, file, store, web, options: { url: web.url, root: path.join(root, "runtime"), intervalMs: 20, output: { write() {} } } };
}
const capacity = () => ({ at: Date.now(), availableGiB: 20, cpuPercent: 10 });
function fakeAgents({ failFirstB = true, alwaysFail = false, rejectReview = false } = {}) {
  const calls = new Map();
  return { calls, run: async (argv, options) => {
    if (argv[0] !== "claude") return guardedProcess(argv, { ...options, scope: false });
    const id = path.basename(options.cwd).slice("waga-proof-".length), review = argv.includes("--json-schema");
    if (!review) {
      calls.set(id, (calls.get(id) || 0) + 1);
      if (id === "a" || id === "b") await fs.writeFile(path.join(options.cwd, `${id}.mjs`), `export default ${alwaysFail || id === "b" && failFirstB && calls.get(id) === 1 ? 0 : id === "a" ? 2 : 3};\n`);
    }
    return { exitCode: 0, signal: null, stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, session_id: argv[argv.indexOf("--session-id") + 1], result: "fixture answer", total_cost_usd: 0, ...(review ? { structured_output: { verdict: rejectReview ? "fail" : "pass", reason: "fixture independent inspection" } } : {}) }), stderr: "" };
  } };
}

test("real checks and isolated worktrees retry only the failed unit, bind artifacts, and require final approval", async t => {
  const f = await fixture(t), native = fakeAgents();
  const run = await runWorkflow(f.file, { ...f.options, sample: capacity, processRunner: native.run });
  assert.equal(run.state, "review_required"); assert.deepEqual(Object.fromEntries(native.calls), { a: 1, b: 2, join: 1 });
  const b = run.nodes.find(node => node.id === "b"); assert.equal(b.attempts[0].check.exitCode, 1); assert.equal(b.attempts[1].check.exitCode, 0);
  assert.notEqual(b.attempts[1].worker.sessionId, b.attempts[1].review.sessionId);
  assert.equal(await fs.readFile(path.join(f.repo, "a.mjs"), "utf8"), "export default 0;\n");
  const joined = run.nodes.find(node => node.id === "join"); assert.equal(await fs.readFile(path.join(joined.workspace, "a.mjs"), "utf8"), "export default 2;\n");
  assert.equal(f.store.control(run.id, { action: "approve" }).state, "approved");
  const resumed = await runWorkflow(f.file, { ...f.options, resume: run.id }); assert.equal(resumed.state, "approved");
});

test("two unchanged correction rounds stop, preserve other successes, and block dependants", async t => {
  const spec = structuredClone(manifest); spec.nodes.push({ id: "blocked", title: "B 후속", role: "scan", prompt: "Inspect B", dependsOn: ["b"], check: [process.execPath, "-e", "process.exit(0)"] });
  const f = await fixture(t, spec), native = fakeAgents({ alwaysFail: true });
  const run = await runWorkflow(f.file, { ...f.options, sample: capacity, processRunner: native.run });
  assert.equal(run.state, "needs-replan"); assert.equal(run.nodes[0].stalls, 2); assert.equal(run.nodes[0].attempts.length, 3);
  assert.equal(run.nodes.find(node => node.id === "blocked").attempts.length, 0);
  assert.throws(() => f.store.control(run.id, { action: "approve" }), { status: 409 });
});

test("resource wait starts no worker, resumes when actual gate permits, and API persists traces across restart", async t => {
  const spec = { ...manifest, nodes: [manifest.nodes[0]] }, f = await fixture(t, spec), native = fakeAgents();
  let availableGiB = 5;
  const promise = runWorkflow(f.file, { ...f.options, sample: () => ({ ...capacity(), availableGiB }), processRunner: native.run });
  let run;
  for (let i = 0; i < 100; i++) { run = f.store.list(f.repo)[0]; if (run?.state === "waiting-resource") break; await wait(10); }
  assert.equal(run.state, "waiting-resource"); assert.equal(native.calls.size, 0);
  availableGiB = 20;
  const result = await promise; assert.equal(result.state, "review_required");
  const credential = JSON.parse(await fs.readFile(path.join(f.options.root, result.id, "client.json")));
  const document = JSON.parse(await fs.readFile(new URL("./fixtures/claude-workflow-otel.json", import.meta.url)));
  const response = await fetch(`${f.web.origin}/api/runs/${result.id}/traces`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential.secret}` }, body: JSON.stringify(document) });
  assert.equal(response.status, 200);
  const restarted = new RunStore(f.store.directory).read(result.id); assert.ok(restarted.traceSpans.some(span => span.attributes.tool_name === "Edit")); assert.equal(restarted.secretHash, undefined);
  const rejected = await fetch(`${f.web.origin}/api/runs/${result.id}/traces`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" }, body: JSON.stringify(document) }); assert.equal(rejected.status, 403);
});

test("machine pass with verifier rejection never becomes task pass", async t => {
  const f = await fixture(t, { ...manifest, nodes: [manifest.nodes[0]] }), native = fakeAgents({ rejectReview: true });
  const run = await runWorkflow(f.file, { ...f.options, sample: capacity, processRunner: native.run });
  assert.equal(run.state, "needs-replan"); assert.ok(run.nodes[0].attempts.every(row => row.check.exitCode === 0 && !row.passed));
});

test("resource pressure terminates only the owned real child process", async () => {
  const result = await guardedProcess([process.execPath, "-e", "setInterval(()=>{},1000)"], { scope: false, intervalMs: 20, monitor: async () => { throw new Error("resource pressure"); } });
  assert.equal(result.failure, "resource pressure"); assert.equal(result.signal, "SIGTERM");
});

test("invalid cycles, undeclared inputs and escaping paths are rejected before launching", () => {
  const cycle = structuredClone(manifest); cycle.nodes[0].dependsOn = ["join"]; assert.throws(() => validateRun(cycle), { status: 400 });
  const missing = structuredClone(manifest); missing.nodes[2].inputs[0].path = "secret"; assert.throws(() => validateRun(missing), { status: 400 });
  const traversal = structuredClone(manifest); traversal.nodes[0].outputs = ["../secret"]; assert.throws(() => validateRun(traversal), { status: 400 });
});

test("interrupted runner resumes only remaining work and keeps approved upstream artifacts", async t => {
  const f = await fixture(t), native = fakeAgents({ failFirstB: false });
  let interrupted = false;
  const processRunner = async (argv, options) => {
    if (!interrupted && argv[0] === "claude" && path.basename(options.cwd) === "waga-proof-b") { interrupted = true; throw new Error("proof interruption"); }
    return native.run(argv, options);
  };
  await assert.rejects(runWorkflow(f.file, { ...f.options, sample: capacity, processRunner }), /proof interruption/);
  const saved = f.store.read(f.store.list(f.repo)[0].id); assert.equal(saved.nodes[0].state, "passed");
  const result = await runWorkflow(f.file, { ...f.options, resume: saved.id, sample: capacity, processRunner });
  assert.equal(result.state, "review_required"); assert.deepEqual(Object.fromEntries(native.calls), { a: 1, b: 1, join: 1 });
});

test("run capability cannot control runs or reach another run, duplicate events are idempotent", async t => {
  const f = await fixture(t), run = f.store.create(manifest, f.repo), other = f.store.create(manifest, f.repo);
  const request = (id, suffix, value) => fetch(`${f.web.origin}/api/runs/${id}${suffix}`, { method: "POST", headers: { Authorization: `Bearer ${run.secret}`, "Content-Type": "application/json" }, body: JSON.stringify(value) });
  assert.equal((await request(run.id, "/control", { action: "stop" })).status, 403);
  assert.equal((await request(other.id, "/events", { type: "end", eventId: crypto.randomUUID() })).status, 403);
  const event = { type: "start", sourceCommit: "a".repeat(40), eventId: crypto.randomUUID() };
  const once = await (await request(run.id, "/events", event)).json(), twice = await (await request(run.id, "/events", event)).json();
  assert.equal(once.revision, twice.revision); assert.equal(twice.secretHash, undefined); assert.equal(twice.secret, undefined);
  assert.equal((await request(run.id, "/events", { eventId: crypto.randomUUID(), type: "resource", sample: { availableGiB: "bad", cpuPercent: 0 } })).status, 400);
});

test("malformed manifest collections are client errors", () => {
  for (const node of [null, { ...manifest.nodes[0], inputs: {} }, { ...manifest.nodes[0], inputs: [null] }, { ...manifest.nodes[0], outputs: "file" }, { ...manifest.nodes[0], dependsOn: {} }]) assert.throws(() => validateRun({ ...manifest, nodes: [node] }), { status: 400 });
  assert.throws(() => validateRun({ ...manifest, models: { unknown: "haiku" } }), { status: 400 });
});
