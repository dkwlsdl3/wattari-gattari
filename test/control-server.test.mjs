import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ControlClient } from "../src/control-client.mjs";
import { ControlServer } from "../src/control-server.mjs";

class FakeHost extends EventEmitter {
  state = { revision: 0, workspaces: [] };

  snapshot() {
    return structuredClone(this.state);
  }

  async dispatch(method, params) {
    if (method !== "workspace/register") throw Object.assign(new Error("unknown method"), { code: "METHOD_NOT_FOUND" });
    if (!this.state.workspaces.some((workspace) => workspace.path === params.path)) {
      this.state = {
        revision: this.state.revision + 1,
        workspaces: [...this.state.workspaces, { path: params.path, name: path.basename(params.path), sessions: [] }],
      };
      this.emit("state", this.snapshot());
    }
    return this.snapshot();
  }
}

function socketFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "waga-control-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true }));
  return path.join(directory, "control.sock");
}

function waitForState(client, predicate) {
  return new Promise((resolve) => {
    const listener = (state) => {
      if (!predicate(state)) return;
      client.off("state", listener);
      resolve(state);
    };
    client.on("state", listener);
  });
}

test("broadcasts an empty workspace immediately to every connected TUI client", async (t) => {
  const socketPath = socketFixture(t);
  const host = new FakeHost();
  const server = new ControlServer({ socketPath, host });
  await server.start();
  t.after(() => server.close());
  assert.equal(fs.statSync(socketPath).mode & 0o777, 0o600);

  const first = new ControlClient(socketPath);
  const second = new ControlClient(socketPath);
  await first.connect();
  await second.connect();
  t.after(() => first.close());
  t.after(() => second.close());

  const firstState = waitForState(first, (state) => state.revision === 1);
  const secondState = waitForState(second, (state) => state.revision === 1);
  await second.request("workspace/register", { path: "/home/demo/work/docs-site" });
  const [seenByFirst, seenBySecond] = await Promise.all([firstState, secondState]);
  assert.equal(seenByFirst.revision, 1);
  assert.deepEqual(seenByFirst, seenBySecond);
  assert.deepEqual(seenByFirst.workspaces, [{
    path: "/home/demo/work/docs-site",
    name: "docs-site",
    sessions: [],
  }]);
});

test("returns typed host failures without closing the persistent connection", async (t) => {
  const socketPath = socketFixture(t);
  const server = new ControlServer({ socketPath, host: new FakeHost() });
  await server.start();
  t.after(() => server.close());
  const client = new ControlClient(socketPath);
  await client.connect();
  t.after(() => client.close());

  await assert.rejects(client.request("missing", {}), { code: "METHOD_NOT_FOUND" });
  const state = await client.request("workspace/register", { path: "/workspace" });
  assert.equal(state.workspaces[0].path, "/workspace");
});
