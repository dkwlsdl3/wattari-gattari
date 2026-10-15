import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { startWebServer } from "../src/web-server.mjs";

async function fixture(t, { now = Date.now, terminalSpawn } = {}) {
  const sessions = ["claude", "codex"].map(provider => ({ id: `${provider}:proof`, provider, nativeId: "proof", name: "waga-proof-terminal", cwd: "/tmp", status: "needs-input" }));
  const web = await startWebServer({ port: 0, now, terminalSpawn, bridge: {
    discover: async () => ({ sessions, warnings: [] }),
    // A real PTY child exercises raw keyboard input, resizing and process exit.
    connection: async target => {
      assert.ok(sessions.some(row => row.id === target));
      return { command: process.execPath, cwd: "/tmp", args: ["-e", `process.stdin.setRawMode(true);process.stdin.resume();process.stdout.write('Approve operation? 1. Yes 2. No\\r\\n');process.stdin.on('data',data=>process.stdout.write('INPUT:'+JSON.stringify(data.toString())+'\\r\\n'));process.on('SIGWINCH',()=>process.stdout.write('SIZE:'+process.stdout.columns+'x'+process.stdout.rows+'\\r\\n'));`] };
    },
  } });
  t.after(() => web.close());
  const token = web.url.split("#")[1], headers = { Origin: web.origin, Cookie: `waga_web=${token}`, "Content-Type": "application/json" };
  const ticket = async target => {
    const response = await fetch(`${web.origin}/api/sessions/${encodeURIComponent(target)}/terminal`, { method: "POST", headers, body: "{}" });
    assert.equal(response.status, 200); return (await response.json()).ticket;
  };
  async function connect(key, override = {}) {
    const ws = new WebSocket(`${web.origin.replace('http:', 'ws:')}/api/terminal?ticket=${key}`, { headers: { ...headers, ...override } });
    const messages = [];
    ws.on("message", data => messages.push(JSON.parse(data)));
    t.after(() => ws.terminate());
    await once(ws, "open");
    return { ws, messages };
  }
  return { web, headers, ticket, connect };
}
async function until(check) {
  const end = Date.now() + 3000;
  while (!check()) { if (Date.now() > end) throw new Error("Timed out waiting for terminal output"); await new Promise(resolve => setTimeout(resolve, 10)); }
}

for (const provider of ["claude", "codex"]) test(`${provider} web input uses the exact attached PTY, including permission selections and Korean text`, async t => {
  const f = await fixture(t), { ws, messages } = await f.connect(await f.ticket(`${provider}:proof`));
  const output = () => messages.filter(row => row.type === "output").map(row => row.data).join("");
  await until(() => output().includes("1. Yes 2. No"));
  for (const data of ["1", "\r", "2", "\x1b[B", "한글 후속 지시\r"]) {
    ws.send(JSON.stringify({ type: "input", data }));
    await until(() => output().includes(`INPUT:${JSON.stringify(data)}`));
  }
  ws.send(JSON.stringify({ type: "resize", cols: 93, rows: 31 }));
  await until(() => output().includes("SIZE:93x31"));
  ws.close(); await once(ws, "close");
});

test("terminal upgrades require cookie, exact Origin and one-use unexpired ticket", async t => {
  let observed = 1; const f = await fixture(t, { now: () => observed });
  const key = await f.ticket("claude:proof");
  await assert.rejects(f.connect(key, { Origin: "https://evil.invalid" }), /403/);
  // An unauthorized origin cannot consume the legitimate browser's ticket.
  const { ws } = await f.connect(key); await assert.rejects(f.connect(key), /403/);
  await assert.rejects(f.connect(await f.ticket("codex:proof"), { Cookie: "" }), /403/);
  const expired = await f.ticket("codex:proof"); observed += 10_001;
  await assert.rejects(f.connect(expired), /403/);
  ws.close(); await once(ws, "close");
  const missing = await fetch(`${f.web.origin}/api/sessions/claude%3Amissing/terminal`, { method: "POST", headers: f.headers, body: "{}" });
  assert.equal(missing.status, 404);
});

test("two controllers cannot race on the same native session, malformed input closes only its frontend", async t => {
  const f = await fixture(t), first = await f.connect(await f.ticket("claude:proof"));
  await assert.rejects(f.connect(await f.ticket("claude:proof")), /403/);
  first.ws.send(JSON.stringify({ type: "resize", cols: 99999, rows: 20 }));
  await once(first.ws, "close");
  const next = await f.connect(await f.ticket("claude:proof"));
  next.ws.send(JSON.stringify({ type: "input", data: "2" }));
  await until(() => next.messages.some(row => row.data?.includes('INPUT:"2"')));
});

test("closing the web server closes terminal sockets and cleans up the owned frontend", async t => {
  const f = await fixture(t), { ws } = await f.connect(await f.ticket("codex:proof"));
  const closing = once(ws, "close"); await f.web.close(); await closing;
  assert.equal(ws.readyState, WebSocket.CLOSED);
});

test("terminal connection failures release the session reservation", async t => {
  const f = await fixture(t, { terminalSpawn: () => { throw new Error("spawn failed"); } });
  for (let i = 0; i < 2; i++) {
    const { ws, messages } = await f.connect(await f.ticket("claude:proof"));
    await until(() => messages.some(row => row.type === "error"));
    assert.equal(messages.find(row => row.type === "error").message, "spawn failed");
    if (ws.readyState !== WebSocket.CLOSED) await once(ws, "close");
  }
});
