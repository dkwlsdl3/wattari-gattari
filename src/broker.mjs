import fs from "node:fs";
import crypto from "node:crypto";
import net from "node:net";
import path from "node:path";

import { readJsonLines, writeJsonLine } from "./line-json.mjs";
import { APP_ID } from "./product.mjs";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

class BrokerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function defaultSocketPath(env = process.env) {
  if (env.WAGA_SOCKET || env.AGENT_BUS_SOCKET) return env.WAGA_SOCKET || env.AGENT_BUS_SOCKET;
  const runtimeDir = env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
  return path.join(runtimeDir, APP_ID, "bus.sock");
}

export class Broker {
  #adapters;
  #queues = new Map();
  #server = null;
  #ownsSocket = false;

  constructor({ socketPath = defaultSocketPath(), adapters = [] } = {}) {
    this.socketPath = socketPath;
    this.#adapters = adapters;
  }

  async start() {
    if (this.#server) return;
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.socketPath)) {
      throw new BrokerError("SOCKET_EXISTS", `Refusing to replace existing socket: ${this.socketPath}`);
    }

    const server = net.createServer((socket) => this.#handleConnection(socket));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, resolve);
    });
    fs.chmodSync(this.socketPath, 0o600);
    server.on("error", () => {});
    this.#server = server;
    this.#ownsSocket = true;
  }

  async close() {
    const server = this.#server;
    this.#server = null;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (this.#ownsSocket && fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
    this.#ownsSocket = false;
  }

  async #agents() {
    const groups = await Promise.all(this.#adapters.map(async (adapter) => {
      const agents = await adapter.listAgents();
      return agents.map((agent) => ({ ...agent, provider: agent.provider ?? adapter.provider, adapter }));
    }));
    return groups.flat();
  }

  async #resolveTarget(target) {
    if (typeof target !== "string" || target.trim() === "") {
      throw new BrokerError("INVALID_TARGET", "target must be a non-empty string");
    }
    const agents = await this.#agents();
    const exactId = agents.find((agent) => agent.id === target);
    if (exactId) return exactId;
    const byName = agents.filter((agent) => agent.name === target);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw new BrokerError("AMBIGUOUS_TARGET", `Multiple agents are named ${target}`);
    throw new BrokerError("AGENT_NOT_FOUND", `No agent matches ${target}`);
  }

  async #dispatch(request) {
    switch (request?.method) {
      case "list_agents": {
        const agents = await this.#agents();
        return agents.map(({ adapter: _adapter, ...agent }) => agent);
      }
      case "ask_agent": {
        const agent = await this.#resolveTarget(request.params?.target);
        const task = request.params?.task;
        if (typeof task !== "string" || task.trim() === "") {
          throw new BrokerError("INVALID_TASK", "task must be a non-empty string");
        }
        const timeoutMs = request.params?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
          throw new BrokerError("INVALID_TIMEOUT", `timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}`);
        }
        const requestId = crypto.randomUUID();
        const run = () => this.#withTimeout(
          async (signal) => {
            const result = await agent.adapter.ask(agent, task, {
              timeoutMs,
              signal,
              requestId,
              trust: "untrusted-peer",
              hop: 1,
              maxHops: 1,
            });
            if (result?.autoForwarded === true || (result?.exchangeCount ?? 1) !== 1) {
              throw new BrokerError("PEER_PROTOCOL_VIOLATION", "Agent adapter violated the one-request/one-response contract");
            }
            return { ...result, requestId, exchangeCount: 1, autoForwarded: false };
          },
          timeoutMs,
          agent.id,
        );
        return agent.serialRequests ? this.#serialize(agent.id, run) : run();
      }
      default:
        throw new BrokerError("METHOD_NOT_FOUND", `Unknown method: ${request?.method ?? "<missing>"}`);
    }
  }

  async #serialize(key, run) {
    const previous = this.#queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(run);
    this.#queues.set(key, current);
    try {
      return await current;
    } finally {
      if (this.#queues.get(key) === current) this.#queues.delete(key);
    }
  }

  async #withTimeout(run, timeoutMs, target) {
    const controller = new AbortController();
    let timer;
    try {
      return await Promise.race([
        run(controller.signal),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new BrokerError("TIMEOUT", `Timed out waiting for ${target}`));
            controller.abort();
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  #handleConnection(socket) {
    let handled = false;
    socket.on("error", () => {});
    readJsonLines(socket, async (request) => {
      if (handled) return;
      handled = true;
      const id = request?.id ?? null;
      try {
        const result = await this.#dispatch(request);
        writeJsonLine(socket, { id, ok: true, result });
      } catch (error) {
        writeJsonLine(socket, {
          id,
          ok: false,
          error: { code: error.code ?? "INTERNAL_ERROR", message: error.message },
        });
      } finally {
        socket.end();
      }
    });
  }
}
