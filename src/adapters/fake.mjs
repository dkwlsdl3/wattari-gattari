export class FakeAdapter {
  provider = "fake";
  notifications = [];

  constructor({ agents = [{ name: "fake1" }], delayMs = 0 } = {}) {
    this.agents = agents.map((agent) => ({
      id: `fake:${agent.name}`,
      name: agent.name,
      status: "idle",
      serialRequests: agent.serialRequests ?? false,
    }));
    this.delayMs = delayMs;
  }

  async listAgents() {
    return this.agents;
  }

  async ask(agent, task, { signal } = {}) {
    if (this.delayMs) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        }, { once: true });
      });
    }
    return { target: agent.id, reply: `echo:${task}` };
  }

  async notify(agent, message) {
    this.notifications.push({ target: agent.id, message });
  }
}
