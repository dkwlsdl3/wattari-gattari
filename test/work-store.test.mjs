import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { WorkStore } from "../src/work-store.mjs";
import { RunStore } from "../src/run-store.mjs";
import { startWebServer } from "../src/web-server.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "waga-proof-work-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new WorkStore(path.join(root, "works"));
  const sessions = ["claude", "codex"].map(provider => ({ id: `${provider}:proof`, provider, name: "waga-proof-work", cwd: root }));
  return { root, store, sessions, create: (instruction = "한글 지시\n원문 유지", session = sessions[0], extra = {}) => store.create({ id: crypto.randomUUID(), instruction, ...extra }, session) };
}

test("work preserves original text, references and follow-ups across reload without conflating delivery and completion", async t => {
  const f = await fixture(t), work = f.create();
  assert.equal(work.delivery, "unconfirmed");
  assert.deepEqual(f.store.create({ id: work.id, instruction: work.instruction }, f.sessions[0]), work);
  assert.throws(() => f.create("다른 내용", f.sessions[0], { id: work.id }), { status: 409 });
  f.store.references(work.id, ["docs/adr/README.md@abc", "https://example.invalid/source"]);
  f.store.submitted(work.id, f.sessions[0].id); f.store.delivered(work.id);
  assert.throws(() => f.store.submitted(work.id, f.sessions[0].id), { status: 409 });
  const follow = f.create("방금 지시에서 한 가지만 정정합니다.", f.sessions[0], { parentId: work.id });
  assert.equal(follow.parentId, work.id);
  assert.equal(follow.rootId, work.id);
  assert.throws(() => f.create("후속", f.sessions[1], { parentId: work.id }), { status: 409 });
  const saved = new WorkStore(f.store.directory).read(work.id);
  assert.equal(saved.instruction, work.instruction); assert.equal(saved.delivery, "submitted"); assert.equal(saved.state, undefined);
  assert.equal(saved.references[0].origin, "user"); assert.ok(saved.references[0].addedAt);
  assert.equal((await fs.stat(path.join(f.store.directory, `${work.id}.json`))).mode & 0o777, 0o600);
});

test("history navigation excludes old identical messages and refuses ambiguous content matches", async t => {
  const f = await fixture(t), old = { id: "old", role: "user", text: "같은 지시" };
  const work = f.store.create({ id: crypto.randomUUID(), instruction: old.text }, f.sessions[0], [old]);
  f.store.submitted(work.id, f.sessions[0].id);
  assert.equal(f.store.reconcile(f.sessions[0].id, [old])[0].messageId, undefined);
  const a = { ...old, id: "new-a" }, b = { ...old, id: "new-b" };
  assert.equal(f.store.reconcile(f.sessions[0].id, [old, a, b])[0].messageId, undefined);
  const matched = f.store.reconcile(f.sessions[0].id, [old, a])[0];
  assert.equal(matched.messageId, a.id); assert.equal(matched.messageRelation, "content-match");
  assert.equal(matched.delivery, "unconfirmed");
});

test("work storage rejects invalid IDs, control input, oversized references and symlink records", async t => {
  const f = await fixture(t);
  assert.throws(() => f.store.read("../escape"), { status: 400 });
  assert.throws(() => f.create("\x1b[3~"), { status: 400 });
  const work = f.create(); assert.throws(() => f.store.references(work.id, [""]), { status: 400 });
  const id = crypto.randomUUID(); await fs.symlink(path.join(f.store.directory, `${work.id}.json`), path.join(f.store.directory, `${id}.json`));
  assert.throws(() => f.store.read(id), { code: "ELOOP" });
});

test("native Enter records the exact work once, approval keys remain opaque, and a foreign-session work sends nothing", async t => {
  const f = await fixture(t), writes = [];
  f.sessions[0].cwd = path.join(f.root, "native-project");
  const web = await startWebServer({ port: 0, cwd: f.root, workStore: f.store, runStore: new RunStore(path.join(f.root, "runs")), bridge: {
    discover: async () => ({ sessions: f.sessions, warnings: [] }), history: async () => ({ messages: [] }), connection: async () => ({}),
  }, terminalFactory: async () => ({ write: async data => { writes.push(data); }, kill() {}, onData() {}, onExit() {} }) });
  t.after(() => web.close());
  const headers = { Cookie: `waga_web=${web.url.split("#")[1]}`, Origin: web.origin, "Content-Type": "application/json" };
  const request = (url, body) => fetch(`${web.origin}/api/${url}`, { headers, ...(body ? { method: "POST", body: JSON.stringify(body) } : {}) });
  const create = await request(`works?session=${f.sessions[0].id}`, { id: crypto.randomUUID(), instruction: "실제 지시" });
  assert.equal(create.status, 201); const work = await create.json();
  const wrong = await request(`works/${work.id}?session=${f.sessions[1].id}`); assert.equal(wrong.status, 404);
  const refs = await request(`works/${work.id}?session=${f.sessions[0].id}`, { references: ["reference.md"] }); assert.equal(refs.status, 200);
  const ticket = await (await request(`sessions/${f.sessions[0].id}/terminal`, {})).json();
  const ws = new WebSocket(`${web.origin.replace("http:", "ws:")}/api/terminal?ticket=${ticket.ticket}`, { headers });
  t.after(() => ws.terminate()); await once(ws, "open");
  const send = async input => { const next = once(ws, "message"); ws.send(JSON.stringify({ type: "input", ...input })); return JSON.parse((await next)[0]); };
  // Wait for the ready message before a request/ack pair.
  if (ws.readyState !== WebSocket.OPEN) throw Error("socket closed");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await send({ data: "2\r", question: "native-question" })).type, "input-result");
  assert.equal(f.store.read(work.id).submitAttemptedAt, undefined);
  assert.equal((await send({ data: "\r", workId: work.id })).type, "input-result");
  assert.equal(f.store.read(work.id).delivery, "submitted");
  const foreign = f.create("다른 세션의 지시", f.sessions[1]);
  const before = writes.length;
  assert.equal((await send({ data: "\r", workId: foreign.id })).type, "error");
  assert.equal(writes.length, before);
  const invalid = await request("runs", { workId: crypto.randomUUID() }); assert.equal(invalid.status, 404);
  const manifest = { workId: work.id, title: "연결 실행", sourceCwd: f.sessions[0].cwd, nodes: [{ id: "check", title: "검사", role: "scan", prompt: "확인", check: [process.execPath, "-e", "process.exit(0)"] }] };
  const runResponse = await request("runs", manifest); assert.equal(runResponse.status, 201); const run = await runResponse.json();
  const mine = await request(`runs?session=${f.sessions[0].id}`); assert.deepEqual((await mine.json()).runs.map(row => row.id), [run.id]);
  assert.equal((await request(`runs/${run.id}?session=${f.sessions[0].id}`)).status, 200);
  assert.equal((await request(`runs/${run.id}?session=${f.sessions[1].id}`)).status, 404);
  const wrongFolder = await request("runs", { ...manifest, sourceCwd: "/unrelated" }); assert.equal(wrongFolder.status, 409);
  const amend = await request(`works?session=${f.sessions[0].id}`, { id: crypto.randomUUID(), parentId: work.id, instruction: "완료 조건을 정정합니다." });
  assert.equal(amend.status, 201); const child = await amend.json();
  const detail = await (await request(`works/${child.id}?session=${f.sessions[0].id}`)).json();
  assert.deepEqual(detail.instructions.map(row => row.instruction), ["실제 지시", "완료 조건을 정정합니다."]);
  assert.equal(detail.runs[0].workId, work.id); // Old evidence still names the old instruction.
});
