import { SessionBridge } from "./session-bridge.mjs";

const sessions = [
  { id: "claude:demo-claude", nativeId: "c1", sessionId: "demo-claude", provider: "claude", name: "API review", cwd: "/demo/app", status: "idle", updatedAt: 2 },
  { id: "codex:demo-codex", nativeId: "demo-codex", sessionId: "demo-codex", provider: "codex", name: "Regression tests", cwd: "/demo/app", status: "working", updatedAt: 1 },
];

function fakeProvider(name) {
  return {
    name,
    async list() { return sessions.filter((session) => session.provider === name); },
    async ask(session, _message, { requestId }) {
      return { target: session.id, requestId, reply: `${session.name}: DEMO_OK`, exchangeCount: 1, autoForwarded: false };
    },
  };
}

const bridge = new SessionBridge({ providers: [fakeProvider("claude"), fakeProvider("codex")] });
const discovered = await bridge.discover();
const answer = await bridge.ask("claude:demo-claude", "status?");
console.log(JSON.stringify({ discovered, answer }, null, 2));
