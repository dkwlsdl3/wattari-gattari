import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import net from "node:net";

import { readJsonLines, writeJsonLine } from "./line-json.mjs";

export class ControlClient extends EventEmitter {
  #socket = null;
  #pending = new Map();

  constructor(socketPath) {
    super();
    this.socketPath = socketPath;
  }

  async connect() {
    if (this.#socket) return;
    const socket = net.connect(this.socketPath);
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.on("error", (error) => this.#fail(error));
    socket.once("close", () => {
      if (this.#socket === socket) this.#socket = null;
      this.#fail(new Error("Control connection closed"));
      this.emit("disconnected");
    });
    readJsonLines(socket, (message) => this.#receive(message));
    this.#socket = socket;
  }

  request(method, params = {}) {
    if (!this.#socket) return Promise.reject(new Error("Control client is not connected"));
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      writeJsonLine(this.#socket, { id, method, params });
    });
  }

  close() {
    const socket = this.#socket;
    this.#socket = null;
    socket?.destroy();
    this.#fail(new Error("Control client closed"));
  }

  #receive(message) {
    if (typeof message?.event === "string") {
      this.emit(message.event, message.data);
      return;
    }
    const pending = this.#pending.get(message?.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else {
      const error = new Error(message.error?.message ?? "Control request failed");
      error.code = message.error?.code;
      pending.reject(error);
    }
  }

  #fail(error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}
