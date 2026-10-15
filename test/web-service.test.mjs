import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { serviceToken } from "../src/web-service.mjs";
import { startWebServer, serveWeb } from "../src/web-server.mjs";

const bridge = { discover: async () => ({ sessions: [], warnings: [] }) };

test("service restart preserves browser authentication and private token", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waga-proof-service-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state", "web-token");
  const token = serviceToken(file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const first = await startWebServer({ bridge, port: 0, token });
  t.after(() => first.close());
  const auth = await fetch(`${first.origin}/api/auth`, { method: "POST",
    headers: { "Content-Type": "application/json", Origin: first.origin }, body: JSON.stringify({ token }) });
  assert.equal(auth.status, 200);
  const cookie = auth.headers.get("set-cookie").split(";", 1)[0];
  await first.close();
  const second = await startWebServer({ bridge, port: Number(new URL(first.origin).port), token: serviceToken(file) });
  t.after(() => second.close());
  assert.equal((await fetch(`${second.origin}/api/sessions`, { headers: { Cookie: cookie } })).status, 200);
  fs.writeFileSync(file, "invalid");
  assert.throws(() => serviceToken(file), /Invalid web service token/);
  assert.equal(fs.readFileSync(file, "utf8"), "invalid");
});

test("service readiness output omits authentication secret", async () => {
  const token = "a".repeat(64);
  let output = "";
  await serveWeb({ bridge, port: 0, token, showToken: false, output: { write(value) {
    output += value;
    process.emit("SIGTERM");
  } } });
  assert.match(output, /^Waga web: http:\/\/127\.0\.0\.1:\d+\/\n$/);
  assert.equal(output.includes(token), false);
});
