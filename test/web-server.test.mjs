import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startWebServer, serveWeb } from "../src/web-server.mjs";
import { SessionBridge } from "../src/session-bridge.mjs";
import { RequestStore } from "../src/request-store.mjs";
import { runCli } from "../src/cli.mjs";

const id = "codex:11111111-1111-4111-8111-111111111111";
const session = { id, provider: "codex", nativeId: id.slice(6), sessionId: id.slice(6),
  name: "waga-proof-web", cwd: "/tmp/waga-proof-web", status: "idle", socketPath: "/private/native.sock" };
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, overrides = {}, options = {}) {
  const bridge = { discover: async () => ({ sessions: [session], warnings: [] }),
    preview: async () => ({ input: "<script>alert(1)</script>", output: "답변", limited: true }),
    recentRequests: async () => ({ records: [], limited: false }), ...overrides };
  const web = await startWebServer({ bridge, port: 0, ...options });
  t.after(() => web.close());
  const request = (route, value, headers = {}) => fetch(`${web.origin}${route}`, {
    ...(value === undefined ? {} : { method: "POST", body: JSON.stringify(value), headers: { "Content-Type": "application/json", Origin: web.origin, ...headers } }),
    ...(value === undefined ? { headers } : {}),
  });
  const auth = await request("/api/auth", { token: web.url.split("#")[1] });
  const cookie = auth.headers.get("set-cookie").split(";", 1)[0];
  return { web, request, get: route => request(route, undefined, { Cookie: cookie }),
    post: (route, value, headers = {}) => request(route, value, { Cookie: cookie, ...headers }), cookie };
}

test("web requires local authentication and same-origin JSON for mutations", async t => {
  let submitted = 0;
  const f = await fixture(t, { ask: async () => { submitted++; return { reply: "ok" }; } });
  const page = await f.request("/");
  assert.equal(page.status, 200); assert.match(await page.text(), /작업 그래프/);
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal((await f.request("/api/sessions")).status, 401);
  assert.equal((await f.request("/api/auth", { token: "wrong" })).status, 401);
  assert.equal((await f.get("/style.css")).status, 200);
  assert.equal((await f.get("/app.mjs")).status, 200);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    http.get(`${f.web.origin}/api/sessions`, { headers: { Host: "evil.test", Cookie: f.cookie } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await f.request("/api/sessions", undefined, { Origin: "http://evil.test", Cookie: f.cookie })).status, 403);
  const value = { operationId: crypto.randomUUID(), target: id, message: "hello" };
  assert.equal((await f.post("/api/query", value, { Origin: "http://evil.test" })).status, 403);
  assert.equal((await f.post("/api/query", value, { Origin: "" })).status, 403);
  assert.equal((await f.post("/api/query", value, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await f.post("/api/query", { ...value, message: "x".repeat(70_000) })).status, 413);
  assert.equal(submitted, 0);
  const cookieAuth = await f.request("/api/auth", { token: f.web.url.split("#")[1] });
  assert.match(cookieAuth.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  assert.equal((await f.get("/missing")).status, 404);
  assert.equal((await f.post("/api/missing", {})).status, 404);
});

test("session discovery is coalesced and preview uses server identities without exposing sockets", async t => {
  let discoveries = 0, previews = 0, observed = 0;
  const f = await fixture(t, { discover: async () => { discoveries++; await tick(); return { sessions: [session], warnings: [] }; },
    preview: async row => { previews++; assert.equal(row, session); await tick(); return { input: "input", output: "output" }; } }, { now: () => observed });
  const [left, right] = await Promise.all([f.get("/api/sessions"), f.get("/api/sessions")]);
  assert.equal(left.status, 200); assert.equal(right.status, 200); assert.equal(discoveries, 1);
  const data = await left.json(); assert.equal(data.sessions[0].id, id); assert.equal(data.sessions[0].socketPath, undefined);
  const route = `/api/sessions/${encodeURIComponent(id)}/preview`;
  const responses = await Promise.all([f.get(route), f.get(route)]);
  assert.equal(previews, 1); assert.equal((await responses[0].json()).input, "input");
  assert.equal((await f.get("/api/sessions/claude%3Amissing/preview")).status, 404);
  observed = 6_000;
  await f.get(route); assert.equal(previews, 2); assert.equal(discoveries, 2);
});

test("a browser operation is accepted once and keeps running after its HTTP response ends", async t => {
  let finish, calls = 0;
  const f = await fixture(t, { ask: async (target, message, options) => {
    calls++; assert.equal(target, id); assert.equal(message, "question");
    options.onProgress({ requestId: "request-proof", state: "accepted" });
    await new Promise(resolve => { finish = resolve; });
    return { requestId: "request-proof", reply: "ANSWER" };
  } });
  const value = { operationId: crypto.randomUUID(), target: id, message: "question" };
  assert.equal((await f.post("/api/query", value)).status, 202);
  assert.equal((await f.post("/api/query", value)).status, 202); assert.equal(calls, 1);
  let listing = await (await f.get("/api/requests")).json();
  assert.equal(listing.jobs[0].state, "accepted"); assert.equal(listing.jobs[0].finished, undefined);
  finish(); await tick();
  listing = await (await f.get("/api/requests")).json();
  assert.equal(listing.jobs[0].result.reply, "ANSWER"); assert.equal(listing.jobs[0].finished, true);
  assert.equal(listing.jobs[0].state, "replied");
});

test("web limits outstanding requests and rejects invalid inputs without submitting", async t => {
  const pending = [];
  const f = await fixture(t, { ask: () => new Promise(resolve => pending.push(resolve)) });
  for (const value of [{}, { operationId: crypto.randomUUID(), message: "hello" },
    { operationId: crypto.randomUUID(), target: id, message: "" }]) assert.equal((await f.post("/api/query", value)).status, 400);
  assert.equal((await f.post("/api/create", { operationId: crypto.randomUUID(), message: "hi", provider: "unknown" })).status, 400);
  assert.equal((await f.post("/api/recover", { operationId: crypto.randomUUID(), requestId: "bad" })).status, 400);
  for (let index = 0; index < 2; index++) assert.equal((await f.post("/api/query", { operationId: crypto.randomUUID(), target: id, message: "question" })).status, 202);
  assert.equal((await f.post("/api/query", { operationId: crypto.randomUUID(), target: id, message: "question" })).status, 429);
  pending.forEach(resolve => resolve({ reply: "ok" })); await tick();
});

test("new work uses provider defaults in the configured workspace and refreshes discovery", async t => {
  let discovered = 0, seen;
  const f = await fixture(t, { discover: async () => { discovered++; return { sessions: [], warnings: [] }; },
    create: async (provider, message, options) => {
      seen = { provider, message, options }; options.onProgress({ message: "creating" });
      return { provider, nativeId: "native", session, routing: { secret: "excluded" } };
    } }, { cwd: "/tmp", filterCwd: "/tmp" });
  await f.get("/api/sessions");
  assert.equal((await f.post("/api/create", { operationId: crypto.randomUUID(), provider: "codex", message: "user task", cwd: "/wrong" })).status, 202);
  await tick(); await f.get("/api/sessions");
  assert.equal(discovered, 2); assert.equal(seen.options.cwd, "/tmp"); assert.deepEqual(seen.options.routing, {});
  const listing = await (await f.get("/api/requests")).json();
  assert.equal(listing.jobs[0].state, "created"); assert.equal(listing.jobs[0].result.session.socketPath, undefined);
  assert.equal(listing.jobs[0].result.routing, undefined);
});

test("failed exchanges retain their request ID and explicit recovery never resubmits", async t => {
  let calls = 0, recoveries = 0;
  const requestId = crypto.randomUUID();
  const f = await fixture(t, { ask: async () => { calls++; throw Object.assign(new Error("timeout"), { code: "REPLY_TIMEOUT", requestId, delivery: "accepted" }); },
    result: async received => { recoveries++; assert.equal(received, requestId); return { requestId, state: "replied", reply: "LATE" }; } });
  await f.post("/api/query", { operationId: crypto.randomUUID(), target: id, message: "question" }); await tick();
  let listing = await (await f.get("/api/requests")).json();
  assert.equal(listing.jobs[0].requestId, requestId); assert.equal(listing.jobs[0].error.code, "REPLY_TIMEOUT");
  await f.post("/api/recover", { operationId: crypto.randomUUID(), requestId }); await tick();
  listing = await (await f.get("/api/requests")).json();
  assert.equal(listing.jobs[1].result.reply, "LATE"); assert.equal(recoveries, 1); assert.equal(calls, 1);
});

test("a restarted web view reads immutable answers from the shared request store", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "waga-proof-web-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new RequestStore(path.join(directory, "requests"));
  assert.deepEqual(await store.recent(), { records: [], limited: false });
  const record = store.create(session, { kind: "ask" });
  store.update(record, { state: "submitted", delivery: "submitted", finished: true });
  store.reply(record.requestId, { state: "replied", delivery: "accepted", reply: "DURABLE" });
  await fs.writeFile(path.join(store.directory, `${crypto.randomUUID()}.json`), "invalid");
  const bridge = new SessionBridge({ providers: [{ name: "codex", list: async () => [session] }], requestStore: store });
  const f = await fixture(t, { recentRequests: () => bridge.recentRequests(), result: value => bridge.result(value) });
  const rows = await (await f.get("/api/requests")).json();
  assert.equal(rows.records.length, 1); assert.equal(rows.records[0].reply, "DURABLE"); assert.equal(rows.records[0].session, undefined);
  assert.equal((await store.recent({ limit: 1 })).limited, true);
  await f.post("/api/recover", { operationId: crypto.randomUUID(), requestId: record.requestId }); await tick();
  assert.equal((await (await f.get("/api/requests")).json()).jobs[0].result.reply, "DURABLE");
});

test("web API surfaces read failures and malformed JSON without crashing", async t => {
  const f = await fixture(t, { preview: async () => { throw new Error("missing transcript"); } });
  assert.equal((await f.get(`/api/sessions/${encodeURIComponent(id)}/preview`)).status, 502);
  const response = await fetch(`${f.web.origin}/api/query`, { method: "POST", headers: {
    Cookie: f.cookie, Origin: f.web.origin, "Content-Type": "application/json",
  }, body: "{" });
  assert.equal(response.status, 400);
  assert.equal((await f.post("/api/query", [])).status, 400);
  assert.equal((await f.get("/api/sessions")).status, 200);
});

test("CLI serve delegates a local workspace and port without opening the terminal dock", async () => {
  let seen;
  const output = { write() {} };
  assert.equal(await runCli(["serve", "--port", "0", "--cwd", "/tmp"], {
    bridge: {}, stdout: output, stderr: output, web: async value => { seen = value; return 0; },
  }), 0);
  assert.equal(seen.port, 0); assert.equal(seen.cwd, "/tmp"); assert.equal(seen.filterCwd, "/tmp");
  assert.equal(await runCli(["list", "--port", "12"], { bridge: {}, stdout: output, stderr: output }), 2);
  assert.equal(await runCli(["serve", "--port", "65536"], { bridge: {}, stdout: output, stderr: output }), 2);
  const bridge = { discover: async () => ({ sessions: [], warnings: [] }), recentRequests: async () => ({ records: [], limited: false }) };
  const starting = serveWeb({ bridge, port: 0, output: { write(value) { assert.match(value, /Waga web: http:\/\/127\.0\.0\.1/); process.emit("SIGTERM"); } } });
  assert.equal(await starting, 0);
});

test("workflow HTTP binds native queries to explicit stages, preserves answers after restart, and rejects unrelated recovery", async t => {
  const { WorkflowStore } = await import("../src/workflow-store.mjs");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "waga-proof-flow-http-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const workflowStore = new WorkflowStore(path.join(directory, "flows"));
  const requestId = crypto.randomUUID(); let calls = 0;
  const f = await fixture(t, { ask: async (target, message, options) => {
    calls++; options.onProgress({ state: "accepted", requestId });
    return { target, requestId, state: "replied", reply: "OBSERVED" };
  } }, { workflowStore, cwd: directory });
  assert.equal((await f.request("/api/workflows")).status, 401);
  assert.equal((await f.post("/api/workflows", { title: "proof" }, { Origin: "http://evil.test" })).status, 403);
  const created = await f.post("/api/workflows", { title: "proof", cwd: "/wrong" });
  assert.equal(created.status, 201); let flow = await created.json(); assert.equal(flow.cwd, directory);
  const route = `/api/workflows/${flow.id}`;
  assert.equal((await f.post(route, { action: "assign", revision: flow.revision, nodeId: "plan", sessionId: "codex:missing" })).status, 404);
  flow = await (await f.post(route, { action: "assign", revision: flow.revision, nodeId: "plan", sessionId: id })).json();
  assert.equal((await f.post(route, { action: "state", revision: 1, nodeId: "plan", state: "active" })).status, 409);
  const operationId = crypto.randomUUID();
  assert.equal((await f.post("/api/query", { operationId, workflowId: flow.id, nodeId: "verify", target: id, message: "query" })).status, 409);
  assert.equal(calls, 0);
  assert.equal((await f.post("/api/query", { operationId, workflowId: flow.id, nodeId: "plan", target: id, message: "query" })).status, 202);
  await tick();
  const operation = await (await f.get(`/api/operations/${operationId}`)).json();
  assert.equal(operation.result.reply, "OBSERVED"); assert.equal(calls, 1);
  const persisted = workflowStore.read(flow.id);
  assert.equal(persisted.nodes[0].state, "pending"); assert.equal(persisted.nodes[0].requests[0].requestId, requestId);
  assert.equal((await f.post("/api/recover", { operationId: crypto.randomUUID(), workflowId: flow.id, nodeId: "plan", requestId: crypto.randomUUID() })).status, 409);
  assert.equal((await f.get(`/api/operations/${crypto.randomUUID()}`)).status, 404);
  const restarted = await fixture(t, {}, { workflowStore: new WorkflowStore(workflowStore.directory), cwd: directory });
  const listing = await (await restarted.get("/api/workflows")).json();
  assert.equal(listing.workflows[0].nodes[0].requests[0].reply, "OBSERVED");
});

test("workflow accepts real repository commits and new sessions bind only to the chosen stage", async t => {
  const { execFileSync } = await import("node:child_process");
  const { WorkflowStore } = await import("../src/workflow-store.mjs");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "waga-proof-flow-git-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const git = args => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init"]);
  git(["-c", "user.name=Waga Proof", "-c", "user.email=proof@example.invalid", "-c", "core.hooksPath=/dev/null", "commit", "--allow-empty", "-m", "proof"]);
  const commit = git(["rev-parse", "HEAD"]);
  const workflowStore = new WorkflowStore(path.join(directory, "flows"));
  const f = await fixture(t, { create: async () => ({ provider: "codex", nativeId: session.nativeId, session }) }, { workflowStore, cwd: directory });
  const flow = await (await f.post("/api/workflows", { title: "repository proof" })).json();
  const route = `/api/workflows/${flow.id}`;
  assert.equal((await f.post(route, { revision: flow.revision, action: "commit", commit: "f".repeat(40) })).status, 400);
  assert.equal((await f.post(route, { revision: flow.revision, action: "commit", commit })).status, 200);
  const operationId = crypto.randomUUID();
  assert.equal((await f.post("/api/create", { operationId, workflowId: flow.id, nodeId: "implement", provider: "codex", message: "proof task" })).status, 202);
  await tick();
  const updated = workflowStore.read(flow.id);
  assert.equal(updated.nodes[1].sessionId, id);
  assert.equal(updated.nodes[1].state, "pending"); assert.equal(updated.nodes[0].sessionId, "");
  const job = await (await f.get(`/api/operations/${operationId}`)).json();
  assert.equal(job.target, id); assert.equal(job.state, "created");
});
