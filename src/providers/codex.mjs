import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { buildPeerEnvelope } from "../bridge/envelope.mjs";
import { CodexAppServerClient } from "../codex-app-server.mjs";

const execFileAsync = promisify(execFile);
const SOURCE_KINDS = ["cli", "vscode", "exec", "appServer"];

async function defaultRun(args) {
  return execFileAsync("codex", args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 30_000 });
}

export function parseDaemonVersion(stdout) {
  let value;
  try { value = JSON.parse(stdout); } catch (cause) {
    throw Object.assign(new Error("Codex daemon version did not return valid JSON", { cause }), { code: "CODEX_DAEMON_INVALID" });
  }
  if (!value || typeof value.status !== "string") throw Object.assign(new Error("Codex daemon version JSON is missing status"), { code: "CODEX_DAEMON_INVALID" });
  return value;
}

function publicStatus(status) {
  if (status?.type === "active") return "working";
  if (status?.type === "systemError") return "error";
  return "idle";
}

function answerIn(items, turnId) {
  return items.find((entry) => entry.turnId === turnId && entry.item?.type === "agentMessage" && entry.item.text)?.item.text ?? null;
}

export class CodexProvider {
  name = "codex";
  #run;
  #clientFactory;
  #wait;

  constructor({ run = defaultRun, clientFactory, wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)) } = {}) {
    this.#run = run;
    this.#clientFactory = clientFactory ?? ((socketPath) => CodexAppServerClient.connectUnixWebSocket({ socketPath }));
    this.#wait = wait;
  }

  async list({ cwd } = {}) {
    return this.#withClient(async (client) => {
      const sessions = [];
      let cursor = null;
      do {
        const page = await client.request("thread/list", {
          archived: false,
          cursor,
          cwd: cwd ? path.resolve(cwd) : undefined,
          limit: 100,
          sortDirection: "desc",
          sortKey: "updated_at",
          sourceKinds: SOURCE_KINDS,
          useStateDbOnly: true,
        });
        for (const thread of page.data) sessions.push({
          id: `codex:${thread.id}`,
          nativeId: thread.id,
          sessionId: thread.sessionId ?? thread.id,
          provider: this.name,
          name: thread.name ?? thread.preview?.split("\n", 1)[0] ?? thread.id,
          cwd: thread.cwd,
          status: publicStatus(thread.status),
          updatedAt: Number(thread.updatedAt ?? 0) * 1_000,
        });
        cursor = page.nextCursor;
      } while (cursor);
      return sessions;
    });
  }

  async send(session, message, { requestId }) {
    return this.#withClient(async (client) => {
      const started = await client.request("turn/start", {
        threadId: session.nativeId,
        input: [],
        toolOutput: {
          name: "waga_peer_message",
          namespace: "waga",
          output: buildPeerEnvelope({ message, requestId, expectsReply: false }),
        },
        turnTrigger: "waga-peer",
      });
      return { target: session.id, requestId, turnId: started.turn.id, delivery: "submitted" };
    });
  }

  async ask(session, message, { requestId, timeoutMs }) {
    return this.#withClient(async (client) => {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const { thread } = await client.request("thread/read", { threadId: session.nativeId, includeTurns: false });
        if (thread.status?.type === "systemError") throw Object.assign(new Error(`Codex target is in systemError state: ${session.id}`), { code: "TARGET_ERROR" });
        if (thread.status?.type !== "active") break;
        if (Date.now() >= deadline) throw Object.assign(new Error(`Codex target stayed busy for ${timeoutMs}ms`), { code: "TIMEOUT" });
        await this.#wait(Math.min(250, Math.max(1, deadline - Date.now())));
      }

      const started = await client.request("turn/start", {
        threadId: session.nativeId,
        input: [],
        toolOutput: {
          name: "waga_peer_message",
          namespace: "waga",
          output: buildPeerEnvelope({ message, requestId, expectsReply: true }),
        },
        turnTrigger: "waga-peer",
      });
      const turnId = started.turn.id;
      while (Date.now() < deadline) {
        const page = await client.request("thread/items/list", { threadId: session.nativeId, turnId, limit: 100, sortDirection: "desc" });
        const reply = answerIn(page.data, turnId);
        if (reply) return { target: session.id, requestId, turnId, reply, exchangeCount: 1, autoForwarded: false };
        const { thread } = await client.request("thread/read", { threadId: session.nativeId, includeTurns: false });
        if (thread.status?.type === "systemError") throw Object.assign(new Error(`Codex turn failed: ${turnId}`), { code: "TARGET_ERROR" });
        await this.#wait(Math.min(250, Math.max(1, deadline - Date.now())));
      }
      throw Object.assign(new Error(`Codex session did not reply within ${timeoutMs}ms`), { code: "TIMEOUT" });
    });
  }

  async daemonInfo({ start = false } = {}) {
    let result = parseDaemonVersion((await this.#run(["app-server", "daemon", "version"])).stdout);
    if (result.status !== "running" && start) {
      await this.#run(["app-server", "daemon", "start"]);
      result = parseDaemonVersion((await this.#run(["app-server", "daemon", "version"])).stdout);
    }
    return result;
  }

  async #withClient(operation) {
    const daemon = await this.daemonInfo({ start: true });
    if (daemon.status !== "running" || typeof daemon.socketPath !== "string" || !path.isAbsolute(daemon.socketPath)) {
      throw Object.assign(new Error("Codex native app-server daemon is unavailable"), { code: "CODEX_DAEMON_UNAVAILABLE" });
    }
    const client = await this.#clientFactory(daemon.socketPath);
    try {
      await client.initialize();
      return await operation(client);
    } finally {
      await client.close();
    }
  }
}
