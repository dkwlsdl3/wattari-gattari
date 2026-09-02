import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { readJsonLines, writeJsonLine } from "./line-json.mjs";

class ControlServerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class ControlServer {
  #host;
  #server = null;
  #clients = new Set();
  #onState;

  constructor({ socketPath, host }) {
    if (typeof socketPath !== "string" || !path.isAbsolute(socketPath)) {
      throw new TypeError("Control socket path must be absolute");
    }
    if (!host || typeof host.dispatch !== "function" || typeof host.snapshot !== "function") {
      throw new TypeError("Control host must provide dispatch() and snapshot()");
    }
    this.socketPath = socketPath;
    this.#host = host;
    this.#onState = (state) => this.#broadcast({ event: "state", data: state });
  }

  async start() {
    if (this.#server) return;
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.socketPath)) {
      throw new ControlServerError("CONTROL_SOCKET_EXISTS", `Refusing to replace existing socket: ${this.socketPath}`);
    }
    this.#server = net.createServer((socket) => this.#handle(socket));
    await new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.socketPath, resolve);
    });
    fs.chmodSync(this.socketPath, 0o600);
    this.#host.on?.("state", this.#onState);
  }

  async close() {
    this.#host.off?.("state", this.#onState);
    for (const socket of this.#clients) socket.destroy();
    this.#clients.clear();
    const server = this.#server;
    this.#server = null;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
  }

  #handle(socket) {
    this.#clients.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => this.#clients.delete(socket));
    writeJsonLine(socket, { event: "state", data: this.#host.snapshot() });
    readJsonLines(socket, async (request) => {
      const id = request?.id ?? null;
      try {
        const result = await this.#host.dispatch(request?.method, request?.params ?? {}, { client: socket });
        writeJsonLine(socket, { id, ok: true, result });
      } catch (error) {
        writeJsonLine(socket, {
          id,
          ok: false,
          error: { code: error.code ?? "INTERNAL_ERROR", message: error.message },
        });
      }
    });
  }

  #broadcast(message) {
    for (const socket of this.#clients) {
      if (!socket.destroyed) writeJsonLine(socket, message);
    }
  }
}
