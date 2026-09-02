import assert from "node:assert/strict";
import test from "node:test";

import { HostPeerAdapter } from "../src/adapters/host-peer.mjs";

test("exposes only matching healthy provider sessions from the shared host", async () => {
  const host = {
    snapshot: () => ({ workspaces: [{ sessions: [
      { id: "codex:one", provider: "codex", name: "one", status: "Awaiting input", routable: true, threadId: "one", cwd: "/w" },
      { id: "claude:abcdef12", provider: "claude", name: "two", status: "Awaiting input", routable: true, threadId: "abcdef12", sessionId: "full", cwd: "/w" },
      { id: "claude:deadbeef", provider: "claude", name: "bad", status: "Error", threadId: "deadbeef", sessionId: "full2", cwd: "/w" },
    ] }] }),
  };
  const adapter = new HostPeerAdapter({ provider: "claude", host });
  assert.deepEqual((await adapter.listAgents()).map(({ id }) => id), ["claude:abcdef12"]);
  await assert.rejects(adapter.notify(), { code: "PEER_NOTIFY_DISABLED" });
});
