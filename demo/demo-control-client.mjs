import { EventEmitter } from "node:events";

const workspacePath = "/demo/sample-app";

const transcript = new Map([
  ["thread-130", [
    { role: "user", text: "중복 상태 갱신 원인을 조사하고 회귀 테스트까지 추가해줘." },
    { role: "assistant", text: "이벤트 병합 경계를 확인했습니다. 격리 테스트를 실행 중입니다." },
  ]],
  ["session-40", [
    { role: "user", text: "스냅샷이 깨졌을 때 fail-closed인지 확인해줘." },
    { role: "assistant", text: "잘못된 스냅샷을 거부하는 테스트까지 통과했습니다." },
  ]],
]);

export class DemoControlClient extends EventEmitter {
  #revision = 42;
  #sessions = [
    {
      id: "codex:thread-130",
      threadId: "thread-130",
      provider: "codex",
      name: "#130 상태 확인 중복 조사",
      cwd: workspacePath,
      status: "Working",
      lastActivity: "테스트 실행 중",
      updatedAt: 3,
      routable: false,
    },
    {
      id: "claude:session-40",
      threadId: "session-40",
      provider: "claude",
      name: "#40 스냅샷 fail-closed",
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
      name: "#126 DB 마이그레이션 검토",
      cwd: workspacePath,
      status: "Completed",
      lastActivity: "최종 보고 완료",
      updatedAt: 1,
      routable: false,
    },
  ];

  async connect() {}

  close() {}

  #state() {
    return {
      revision: this.#revision,
      approval: null,
      workspaces: [
        { path: workspacePath, name: "sample-app", sessions: this.#sessions.map((session) => ({ ...session })) },
        { path: "/demo/docs-site", name: "docs-site", sessions: [] },
      ],
    };
  }

  #detail(threadId) {
    const session = this.#sessions.find((candidate) => candidate.threadId === threadId);
    if (!session) throw new Error(`Unknown demo session: ${threadId}`);
    return {
      ...session,
      sessionId: session.id,
      messages: [...(transcript.get(threadId) ?? [])],
      hasOlderMessages: false,
    };
  }

  #publish() {
    this.#revision += 1;
    this.emit("state", this.#state());
  }

  async request(method, params = {}) {
    if (method === "workspace/register") return this.#state();
    if (["session/open", "session/read", "session/older"].includes(method)) return this.#detail(params.threadId);
    if (method === "session/send") {
      const messages = transcript.get(params.threadId) ?? [];
      messages.push(
        { role: "user", text: params.text },
        { role: "assistant", text: "요청을 받았습니다. 결과와 검증 근거를 함께 정리하겠습니다." },
      );
      transcript.set(params.threadId, messages);
      const session = this.#sessions.find((candidate) => candidate.threadId === params.threadId);
      if (session) {
        session.status = "Working";
        session.lastActivity = "응답 작성 중";
        session.routable = false;
      }
      this.#publish();
      return { delivered: true };
    }
    if (method === "session/setCompleted") {
      const session = this.#sessions.find((candidate) => candidate.id === params.sessionId);
      if (session) {
        session.status = params.completed ? "Completed" : "Awaiting input";
        session.lastActivity = params.completed ? "사용자가 완료 확인" : "다시 열림";
        session.routable = !params.completed;
      }
      this.#publish();
      return { changed: true };
    }
    return { changed: true };
  }
}
