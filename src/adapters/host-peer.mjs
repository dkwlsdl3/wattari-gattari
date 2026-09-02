import { ClaudeShadowAdapter } from "./claude-shadow.mjs";
import { CodexShadowAdapter } from "./codex-shadow.mjs";

export class HostPeerAdapter {
  constructor({ provider, host }) {
    if (provider !== "codex" && provider !== "claude") throw new TypeError("HostPeerAdapter provider must be codex or claude");
    this.provider = provider;
    this.host = host;
  }

  async listAgents() {
    return this.host.snapshot().workspaces.flatMap((workspace) => workspace.sessions)
      .filter((session) => session.provider === this.provider && session.routable === true)
      .map((session) => ({
        id: session.id,
        name: session.name,
        status: session.status,
        serialRequests: true,
        threadId: session.threadId,
        sessionId: session.sessionId,
        cwd: session.cwd,
      }));
  }

  async ask(agent, task, options) {
    if (this.provider === "codex") {
      const adapter = new CodexShadowAdapter({ agents: [{
        id: agent.id,
        name: agent.name,
        threadId: agent.threadId,
        cwd: agent.cwd,
      }] });
      return adapter.ask(agent, task, options);
    }
    const adapter = new ClaudeShadowAdapter({ agents: [{
      id: agent.id,
      name: agent.name,
      shortId: agent.threadId,
      sessionId: agent.sessionId,
      cwd: agent.cwd,
    }] });
    return adapter.ask(agent, task, options);
  }

  async notify() {
    throw Object.assign(new Error("peer notify는 응답 없는 모델 턴을 만들 수 있어 비활성화했습니다"), {
      code: "PEER_NOTIFY_DISABLED",
    });
  }
}
