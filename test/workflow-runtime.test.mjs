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
import { WorkStore } from "../src/work-store.mjs";
import { taskGraph } from '../src/web/task-graph.mjs';
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
  const workStore = new WorkStore(path.join(root, "works"));
  const session = { id: "codex:work-proof", provider: "codex", name: "waga-proof-work", cwd: repo };
  const web = await startWebServer({ bridge: { discover: async () => ({ sessions: [session], warnings: [] }), history: async () => ({ messages: [] }) }, cwd: repo, port: 0, runStore: store, workStore });
  t.after(async () => { await web.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, repo, file, store, workStore, session, web, options: { url: web.url, root: path.join(root, "runtime"), intervalMs: 20, output: { write() {} } } };
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

test("one instruction reopens its isolated diff, real failed and successful checks, environment and report after store reload", async t => {
  const f = await fixture(t), native = fakeAgents();
  const headers = { Cookie: `waga_web=${f.web.url.split("#")[1]}`, Origin: f.web.origin, "Content-Type": "application/json" };
  const instruction = "A는 2, B는 3을 반환하도록 수정하고 실제 동작을 검사해 주세요.\n기존 저장소는 보존합니다.";
  const response = await fetch(`${f.web.origin}/api/works?session=${f.session.id}`, { method: "POST", headers, body: JSON.stringify({ id: crypto.randomUUID(), instruction }) });
  assert.equal(response.status, 201); const work = await response.json();
  const linked = { ...manifest, workId: work.id, sourceCwd: f.repo };
  await fs.writeFile(f.file, JSON.stringify(linked));
  const run = await runWorkflow(f.file, { ...f.options, sample: capacity, processRunner: native.run });
  const reopened = await fetch(`${f.web.origin}/api/works/${work.id}?session=${f.session.id}`, { headers });
  assert.equal(reopened.status, 200); const detail = await reopened.json();
  assert.equal(detail.instruction, instruction); assert.equal(detail.session.cwd, f.repo);
  assert.equal(detail.runs.length, 1); assert.equal(detail.runs[0].id, run.id);
  const b = detail.runs[0].nodes.find(row => row.id === "b");
  assert.equal(b.attempts[0].check.exitCode, 1); assert.equal(b.attempts[1].check.exitCode, 0);
  assert.match(b.attempts[1].check.stdout, /CHECK_OK/); assert.match(b.attempts[1].diff, /\+export default 3/);
  assert.equal(b.attempts[1].check.cwd, b.workspace); assert.equal(b.attempts[1].check.environment.node, process.version);
  assert.ok(b.attempts[1].check.observedAt); assert.deepEqual(b.attempts[1].check.argv, manifest.nodes[1].check);
  assert.equal(new WorkStore(f.workStore.directory).read(work.id).instruction, instruction);
  assert.equal(new RunStore(f.store.directory).read(run.id).workId, work.id);
  assert.equal(f.workStore.read(work.id).delivery, "unconfirmed"); // A run is not proof of native input delivery.
  const resumed = await runWorkflow(f.file, { ...f.options, resume: run.id }); assert.equal(resumed.id, run.id);
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

test('changed check implementation invalidates the passed revision and prevents final approval and dependent reuse', async t => {
  const f = await fixture(t, { ...manifest, nodes: [manifest.nodes[0]] }), native = fakeAgents();
  const run = await runWorkflow(f.file, { ...f.options, sample: capacity, processRunner: native.run });
  await fs.writeFile(path.join(run.nodes[0].workspace, 'check.mjs'), 'process.exit(0); // changed verification\n');
  const response = await fetch(`${f.web.origin}/api/runs/${run.id}/control`, { method: 'POST', headers: { Cookie: `waga_web=${f.web.url.split('#')[1]}`, Origin: f.web.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'approve' }) });
  assert.equal(response.status, 409); assert.equal(f.store.read(run.id).nodes[0].state, 'stale');
  await assert.rejects(runWorkflow(f.file, { ...f.options, resume: run.id, sample: capacity, processRunner: native.run }), /검증이 무효/);
  assert.equal(native.calls.get('a'), 1);
});

test('two disjoint edits can overlap, dependencies wait for verified artifacts, and resource peaks are recorded', async t => {
  const f = await fixture(t, { ...manifest, maxParallel: 2 }), native = fakeAgents({ failFirstB: false });
  let active = 0, peak = 0;
  const processRunner = async (argv, options) => {
    if (argv[0] !== 'claude') return native.run(argv, options);
    active++; peak = Math.max(peak, active);
    try { await wait(50); return await native.run(argv, options); } finally { active--; }
  };
  const run = await runWorkflow(f.file, { ...f.options, sample: capacity, processRunner });
  assert.equal(run.state, 'review_required'); assert.equal(peak, 2); assert.equal(run.metrics.minAvailableGiB, 20); assert.ok(run.metrics.samples > 0);
  assert.equal(await fs.readFile(path.join(run.nodes[2].workspace, 'a.mjs'), 'utf8'), 'export default 2;\n');
});

test('permission denial waits for user judgement without automatic repair calls', async t => {
  const f = await fixture(t, { ...manifest, nodes: [manifest.nodes[0]] }); let calls = 0;
  const run = await runWorkflow(f.file, { ...f.options, sample: capacity, processRunner: async argv => {
    calls++; return { exitCode: 0, stdout: JSON.stringify({ session_id: argv[argv.indexOf('--session-id') + 1], result: 'Denied', permission_denials: [{ tool_name: 'Write' }] }), stderr: '' };
  } });
  assert.equal(calls, 1); assert.equal(run.nodes[0].state, 'permission-wait'); assert.equal(run.nodes[0].attempts[0].failure.action, 'wait');
});

test('a changing patch with the identical failing behavioral check is still stopped as no progress', async t => {
  const f = await fixture(t, { ...manifest, nodes: [manifest.nodes[0]] }), native = fakeAgents({ alwaysFail: true }); let counter = 0;
  const run = await runWorkflow(f.file, { ...f.options, sample: capacity, processRunner: async (argv, options) => {
    const result = await native.run(argv, options);
    if (argv[0] === 'claude' && !argv.includes('--json-schema')) await fs.appendFile(path.join(options.cwd, 'a.mjs'), `// different patch ${++counter}\n`);
    return result;
  } });
  assert.equal(counter, 3); assert.equal(run.nodes[0].state, 'needs-replan');
  assert.notEqual(run.nodes[0].attempts[0].fingerprint, run.nodes[0].attempts[1].fingerprint);
});

test('lost HTTP acknowledgement replays the saved event ID and recovers a completed worker instead of submitting it again', async t => {
  const f = await fixture(t, { ...manifest, nodes: [manifest.nodes[0]] }), native = fakeAgents(), originalFetch = globalThis.fetch; let failures = 0;
  globalThis.fetch = async (url, options) => {
    const response = await originalFetch(url, options);
    if (String(url).endsWith('/events') && JSON.parse(options.body).type === 'attempt' && failures++ < 3) throw Error('lost acknowledgement after server commit');
    return response;
  };
  try { await assert.rejects(runWorkflow(f.file, { ...f.options, sample: capacity, processRunner: native.run }), /lost acknowledgement/); }
  finally { globalThis.fetch = originalFetch; }
  const saved = f.store.read(f.store.list(f.repo)[0].id); assert.equal(saved.nodes[0].state, 'passed');
  const resumed = await runWorkflow(f.file, { ...f.options, resume: saved.id, sample: capacity, processRunner: native.run });
  assert.equal(resumed.state, 'review_required'); assert.equal(native.calls.get('a'), 1); assert.equal(resumed.nodes[0].attempts.length, 1);
});

test('a check which changes its own target cannot certify the changed result', async t => {
  const spec = { ...manifest, maxAttempts: 1, nodes: [{ ...manifest.nodes[0], check: [process.execPath, '-e', "require('fs').writeFileSync('a.mjs','export default 999;\\n')"] }] };
  const f = await fixture(t, spec), native = fakeAgents();
  const run = await runWorkflow(f.file, { ...f.options, sample: capacity, processRunner: native.run });
  assert.equal(run.state, 'needs-replan'); assert.match(run.nodes[0].attempts[0].check.stderr, /검사 실행 중/); assert.equal(run.nodes[0].attempts[0].passed, false);
});

test('verified JSON selects a branch, independent work overlaps, failed checks loop locally and selected paths join', async t => {
  const spec = { ...manifest, maxParallel: 2, nodes: [
    { ...manifest.nodes[0], outputs: ['a.mjs', 'scope.json'] },
    manifest.nodes[1],
    { id: 'selected', title: '선택된 수정', role: 'edit', prompt: 'Selected output returns 2', outputs: ['selected.mjs'], inputs: [{ from: 'a', path: 'a.mjs' }], when: { from: 'a', path: 'scope.json', field: 'target', equals: 'web' }, check: [process.execPath, 'check.mjs', 'selected', '2'] },
    { id: 'unused', title: '불필요한 경로', role: 'edit', outputs: ['unused.json'], prompt: 'Must never run', when: { from: 'a', path: 'scope.json', field: 'target', equals: 'cli' }, check: [process.execPath, '-e', 'process.exit(99)'] },
    { id: 'unused-condition', title: '제외된 조건 자료', role: 'scan', join: 'selected', dependsOn: ['a'], prompt: 'Must never run', when: { from: 'unused', path: 'unused.json', field: 'target', equals: 'web' }, check: [process.execPath, '-e', 'process.exit(99)'] },
    { id: 'unused-child', title: '제외 경로 후속', role: 'scan', prompt: 'Must never run', dependsOn: ['unused'], check: [process.execPath, '-e', 'process.exit(99)'] },
    { id: 'join', title: '선택 경로 합류', role: 'scan', prompt: 'Verify both selected results', join: 'selected', dependsOn: ['unused-child'], inputs: [{ from: 'b', path: 'b.mjs' }, { from: 'selected', path: 'selected.mjs' }], check: [process.execPath, '-e', "const a=await import('./selected.mjs');const b=await import('./b.mjs');if(a.default!==2||b.default!==3)process.exit(1)"] },
  ] };
  const f = await fixture(t, spec), native = fakeAgents(); let active = 0, peak = 0;
  const processRunner = async (argv, options) => {
    if (argv[0] !== 'claude') return native.run(argv, options);
    active++; peak = Math.max(peak, active);
    try {
      await wait(30);
      const result = await native.run(argv, options);
      if (!argv.includes('--json-schema')) {
        const id = path.basename(options.cwd).slice('waga-proof-'.length);
        if (id === 'a') await fs.writeFile(path.join(options.cwd, 'scope.json'), JSON.stringify({ target: 'web' }));
        if (id === 'selected') await fs.writeFile(path.join(options.cwd, 'selected.mjs'), 'export default 2;\n');
      }
      return result;
    } finally { active--; }
  };
  const run = await runWorkflow(f.file, { ...f.options, sample: capacity, processRunner });
  assert.equal(run.state, 'review_required', JSON.stringify(run.nodes.map(n=>({id:n.id,state:n.state,reason:n.attempts.at(-1)?.failure})))); assert.equal(peak, 2);
  assert.equal(run.nodes.find(node => node.id === 'b').attempts.length, 2);
  for (const id of ['unused','unused-child','unused-condition']) { assert.equal(run.nodes.find(node => node.id === id).state, 'skipped'); assert.equal(native.calls.has(id), false); }
  const selected = run.nodes.find(node => node.id === 'selected');
  assert.equal(selected.decision.value, 'web'); assert.equal(selected.decision.selected, true);
  assert.equal(run.nodes.find(node => node.id === 'unused').decision.selected, false);
  assert.equal(selected.decision.sha256, run.nodes[0].attempts[0].artifacts.find(row => row.path === 'scope.json').sha256);
  assert.equal(run.nodes.find(node => node.id === 'join').attempts[0].check.exitCode, 0);
  const graph=taskGraph(run);
  assert.ok(graph.edges.some(edge=>edge.from==='b'&&edge.to==='b'&&edge.kind==='retry'&&edge.basis==='observed'));
  assert.ok(graph.edges.some(edge=>edge.to==='unused'&&edge.kind==='condition'&&edge.inactive));
  const resumed = await runWorkflow(f.file, { ...f.options, resume: run.id, sample: capacity, processRunner });
  assert.equal(resumed.id, run.id); assert.equal(native.calls.get('b'), 2);
});
