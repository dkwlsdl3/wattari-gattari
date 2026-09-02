import { EventEmitter } from "node:events";

const workspacePath = "/demo/sample-app";

export class DemoControlClient extends EventEmitter {
  #revision = 42;
  #sessions = [
    {
      id: "codex:thread-130",
      threadId: "thread-130",
      provider: "codex",
      name: "#130 duplicate state refresh",
      cwd: workspacePath,
      status: "Working",
      workingSince: Date.now() - 12_000,
      lastActivity: "running regression tests",
      updatedAt: 3,
      routable: true,
      gitBranch: "main",
    },
    {
      id: "claude:abcdef12",
      threadId: "abcdef12",
      provider: "claude",
      name: "#40 fail-closed snapshot",
      cwd: workspacePath,
      status: "Awaiting input",
      lastActivity: "READY",
      updatedAt: 2,
      routable: true,
    },
    {
      id: "codex:thread-126",
      threadId: "thread-126",
      provider: "codex",
      name: "#126 migration review",
      cwd: workspacePath,
      status: "Completed",
      lastActivity: "review complete",
      updatedAt: 1,
      routable: false,
    },
  ];

  async connect() {}
  close() {}

  #state() {
    return {
      revision: this.#revision,
      workspaces: [
        { path: workspacePath, name: "sample-app", sessions: this.#sessions.map((session) => ({ ...session })) },
        { path: "/demo/docs-site", name: "docs-site", sessions: [] },
      ],
    };
  }

  #publish() {
    this.#revision += 1;
    this.emit("state", this.#state());
  }

  async request(method, params = {}) {
    if (method === "workspace/register") return this.#state();
    if (method === "session/setCompleted") {
      const session = this.#sessions.find((candidate) => candidate.id === params.sessionId);
      if (session) session.status = params.completed ? "Completed" : "Awaiting input";
      this.#publish();
      return { changed: true };
    }
    return { changed: true };
  }
}
