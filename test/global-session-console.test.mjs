import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { runSessionConsole } from "../src/global-session-console.mjs";

class FakeControlClient extends EventEmitter {
  requests = [];
  closed = false;

  async connect() {}

  async request(method, params) {
    this.requests.push({ method, params });
    if (method === "workspace/register") {
      return {
        revision: 1,
        approval: null,
        workspaces: [{
          path: "/workspace",
          name: "workspace",
          sessions: [{
            id: "codex:thread-1",
            threadId: "thread-1",
            provider: "codex",
            name: "first",
            cwd: "/workspace",
            status: "Awaiting input",
            lastActivity: "ready",
            updatedAt: 1,
            routable: true,
          }],
        }],
      };
    }
    return { changed: true };
  }

  close() { this.closed = true; }
}

test("runs the real console interface with fake terminal and control adapters", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.columns = 100;
  output.rows = 30;
  let rendered = "";
  output.on("data", (chunk) => { rendered += chunk.toString("utf8"); });
  const client = new FakeControlClient();

  const running = runSessionConsole({
    paths: { controlSocketPath: "/tmp/not-used.sock" },
    ensureDaemon: async () => {},
    createClient: () => client,
    inputStream: input,
    outputStream: output,
    workspacePath: "/workspace",
    listenForSignals: false,
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(rendered, /Wattari Gattari/);
  assert.match(rendered, /first/);
  input.emit("keypress", "", { name: "down", ctrl: false, meta: false, shift: false });
  input.emit("keypress", "", { name: "f3", ctrl: false, meta: false, shift: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(client.requests.at(-1), {
    method: "session/setCompleted",
    params: { workspacePath: "/workspace", sessionId: "codex:thread-1", completed: true },
  });

  input.emit("keypress", "", { name: "c", ctrl: true, meta: false, shift: false });
  assert.deepEqual(await running, { exitCode: 0 });
  assert.equal(client.closed, true);
  assert.equal(input.listenerCount("keypress"), 0);
  assert.equal(input.isPaused(), true);
});
