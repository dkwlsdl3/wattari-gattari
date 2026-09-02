import assert from "node:assert/strict";
import test from "node:test";

import { ClaudeShadowAdapter, parseClaudePrintResult } from "../src/adapters/claude-shadow.mjs";

test("parses a successful Claude print result and rejects failures", () => {
  assert.equal(parseClaudePrintResult(JSON.stringify({ type: "result", subtype: "success", result: "pong" })).result, "pong");
  assert.throws(
    () => parseClaudePrintResult(JSON.stringify({ type: "result", subtype: "error", error: "failed" })),
    { code: "CLAUDE_SHADOW_TURN_FAILED" },
  );
});

test("asks through an ephemeral restricted no-tools fork exactly once", async () => {
  let captured;
  const adapter = new ClaudeShadowAdapter({
    agents: [{
      id: "claude:abcdef12",
      name: "claude-one",
      shortId: "abcdef12",
      sessionId: "abcdef12-0000-4000-8000-000000000000",
      cwd: "/workspace",
    }],
    run: async (args, options) => {
      captured = { args, options };
      return { stdout: JSON.stringify({ type: "result", subtype: "success", result: "pong", session_id: "shadow" }) };
    },
  });
  const [agent] = await adapter.listAgents();
  const result = await adapter.ask(agent, "ping", { requestId: "request-1" });
  assert.equal(result.reply, "pong");
  assert.equal(result.exchangeCount, 1);
  assert.equal(result.autoForwarded, false);
  assert(captured.args.includes("--fork-session"));
  assert(captured.args.includes("--no-session-persistence"));
  assert(captured.args.includes("--restricted"));
  assert.deepEqual(captured.args.slice(captured.args.indexOf("--tools"), captured.args.indexOf("--tools") + 2), ["--tools", ""]);
  assert.match(captured.args.at(-1), /request:request-1/);
});
