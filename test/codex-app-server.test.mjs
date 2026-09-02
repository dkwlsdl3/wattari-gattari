import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  CodexAppServerClient,
  configuredMcpServerNames,
  managedAppServerArgs,
  shadowAppServerArgs,
} from "../src/codex-app-server.mjs";

test("keeps live web research while disabling external mutation surfaces", () => {
  const args = shadowAppServerArgs({ mcpServerNames: ["context7", "playwright"] });
  assert.deepEqual(args.slice(0, 8), [
    "app-server",
    "--stdio",
    "-c",
    "mcp_servers={}",
    "-c",
    "web_search=\"live\"",
    "-c",
    "tools.web_search=true",
  ]);
  for (const feature of ["apps", "plugins", "hooks", "browser_use", "computer_use", "multi_agent"]) {
    const index = args.indexOf(feature);
    assert.equal(args[index - 1], "--disable");
  }
  assert.ok(args.includes("mcp_servers.context7.enabled=false"));
  assert.ok(args.includes("mcp_servers.playwright.enabled=false"));
});

test("starts the managed socket without overriding native Codex configuration", () => {
  const args = managedAppServerArgs("/run/user/1001/waga/codex.sock");
  assert.deepEqual(args, [
    "app-server",
    "--listen",
    "unix:///run/user/1001/waga/codex.sock",
  ]);
});

test("discovers configured MCP names and rejects config shapes it cannot disable", () => {
  assert.deepEqual(configuredMcpServerNames(`
[mcp_servers.context7]
[mcp_servers.playwright]
[mcp_servers.playwright.env]
`), ["context7", "playwright"]);
  assert.throws(
    () => configuredMcpServerNames("[mcp_servers]\nplaywright = {}"),
    { code: "CODEX_MCP_CONFIG_UNSUPPORTED" },
  );
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

test("opts out of high-volume deltas that waga never renders", async () => {
  const child = fakeChild();
  const client = new CodexAppServerClient(child);
  const request = new Promise((resolve) => {
    child.stdin.once("data", (chunk) => resolve(JSON.parse(chunk.toString("utf8"))));
  });
  const initialized = client.initialize();
  const message = await request;

  assert.deepEqual(message.params.capabilities.optOutNotificationMethods, [
    "item/agentMessage/delta",
    "item/commandExecution/outputDelta",
    "item/fileChange/outputDelta",
    "item/plan/delta",
    "item/reasoning/summaryTextDelta",
    "item/reasoning/textDelta",
    "thread/realtime/item/transcript/delta",
    "thread/realtime/outputAudio/delta",
    "thread/realtime/transcript/delta",
  ]);
  child.stdout.write(`${JSON.stringify({ id: message.id, result: {} })}\n`);
  await initialized;
});

test("routes an App Server approval request only through the host callback", async () => {
  const child = fakeChild();
  const seen = [];
  new CodexAppServerClient(child, {
    onServerRequest: async (request) => {
      seen.push(request);
      return { decision: "accept" };
    },
  });
  const response = new Promise((resolve) => {
    child.stdin.once("data", (chunk) => resolve(JSON.parse(chunk.toString("utf8"))));
  });
  child.stdout.write(`${JSON.stringify({
    id: 71,
    method: "item/commandExecution/requestApproval",
    params: { command: "git push", reason: "publish" },
  })}\n`);
  assert.deepEqual(await response, { id: 71, result: { decision: "accept" } });
  assert.deepEqual(seen, [{
    method: "item/commandExecution/requestApproval",
    params: { command: "git push", reason: "publish" },
  }]);
});

test("declines approval requests when no direct-human callback exists", async () => {
  const child = fakeChild();
  new CodexAppServerClient(child);
  const response = new Promise((resolve) => {
    child.stdin.once("data", (chunk) => resolve(JSON.parse(chunk.toString("utf8"))));
  });
  child.stdout.write(`${JSON.stringify({
    id: 72,
    method: "item/fileChange/requestApproval",
    params: { reason: "outside workspace" },
  })}\n`);
  assert.deepEqual(await response, { id: 72, result: { decision: "decline" } });
});

test("falls back to denial when a selective host callback has no matching grant", async () => {
  const child = fakeChild();
  new CodexAppServerClient(child, { onServerRequest: async () => undefined });
  const response = new Promise((resolve) => {
    child.stdin.once("data", (chunk) => resolve(JSON.parse(chunk.toString("utf8"))));
  });
  child.stdout.write(`${JSON.stringify({
    id: 75,
    method: "item/commandExecution/requestApproval",
    params: { threadId: "thread", turnId: "turn", itemId: "item", command: "rm -f x" },
  })}\n`);
  assert.deepEqual(await response, { id: 75, result: { decision: "decline" } });
});

test("denies permission widening and MCP elicitation without a host callback", async () => {
  for (const [id, method, expected] of [
    [73, "item/permissions/requestApproval", { permissions: {}, scope: "turn" }],
    [74, "mcpServer/elicitation/request", { action: "decline", content: null, _meta: null }],
  ]) {
    const child = fakeChild();
    new CodexAppServerClient(child);
    const response = new Promise((resolve) => {
      child.stdin.once("data", (chunk) => resolve(JSON.parse(chunk.toString("utf8"))));
    });
    child.stdout.write(`${JSON.stringify({ id, method, params: {} })}\n`);
    assert.deepEqual(await response, { id, result: expected });
  }
});

test("forwards notifications to a persistent host listener", async () => {
  const child = fakeChild();
  const seen = [];
  new CodexAppServerClient(child, {
    onNotification: (notification) => seen.push(notification),
  });
  child.stdout.write(`${JSON.stringify({
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1" } },
  })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [{
    method: "turn/started",
    params: { threadId: "thread-1", turn: { id: "turn-1" } },
  }]);
});
