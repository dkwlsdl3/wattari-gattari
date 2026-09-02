import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { classifyApprovalRequest } from "./approval-policy.mjs";

const MAX_REQUEST_BYTES = 256 * 1024;

function probeSocket(socketPath) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

function respond(socket, requestId, decision, reason) {
  if (socket.destroyed) return;
  socket.end(`${JSON.stringify({ requestId, decision, reason })}\n`);
}

export class ApprovalServer extends EventEmitter {
  #server = null;
  #pending = [];
  #connections = new Set();

  constructor(socketPath) {
    super();
    if (typeof socketPath !== "string" || !path.isAbsolute(socketPath)) {
      throw new TypeError("Approval socket path must be absolute");
    }
    this.socketPath = socketPath;
  }

  async start() {
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    if (fs.existsSync(this.socketPath)) {
      if (await probeSocket(this.socketPath)) {
        throw new Error(`다른 통합 화면이 승인 소켓을 사용 중입니다: ${this.socketPath}`);
      }
      fs.unlinkSync(this.socketPath);
    }
    this.#server = net.createServer((socket) => this.#handle(socket));
    await new Promise((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.socketPath, () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
    fs.chmodSync(this.socketPath, 0o600);
  }

  get pendingCount() {
    return this.#pending.length;
  }

  resolve(requestId, decision) {
    const pending = this.#pending[0];
    if (!pending || pending.requestId !== requestId) return false;
    if (decision !== "approve" && decision !== "deny") throw new TypeError("Unknown approval decision");
    const { socket } = pending;
    this.#pending.shift();
    respond(socket, requestId, decision, decision === "approve" ? "직접 사용자 승인" : "직접 사용자 거부");
    this.emit("resolved", { requestId, decision });
    this.#emitNext();
    return true;
  }

  async close() {
    for (const pending of this.#pending.splice(0)) {
      respond(pending.socket, pending.requestId, "deny", "승인 서비스가 종료됐습니다");
    }
    if (!this.#server) return;
    const server = this.#server;
    this.#server = null;
    for (const socket of this.#connections) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    if (fs.existsSync(this.socketPath)) fs.unlinkSync(this.socketPath);
  }

  #handle(socket) {
    let buffer = "";
    let handled = false;
    this.#connections.add(socket);
    socket.once("close", () => this.#connections.delete(socket));
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_REQUEST_BYTES) {
        handled = true;
        respond(socket, null, "deny", "승인 요청이 너무 큽니다");
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      socket.pause();
      let request;
      try {
        request = JSON.parse(buffer.slice(0, newline));
      } catch {
        respond(socket, null, "deny", "승인 요청 JSON이 올바르지 않습니다");
        return;
      }
      const risk = classifyApprovalRequest(request.payload);
      if (typeof request.requestId !== "string" || !risk) {
        respond(socket, request.requestId ?? null, "deny", "검증할 수 없는 승인 요청입니다");
        return;
      }
      const pending = {
        socket,
        requestId: request.requestId,
        request: { requestId: request.requestId, payload: request.payload, risk },
      };
      this.#pending.push(pending);
      socket.once("close", () => {
        const index = this.#pending.findIndex((entry) => entry.socket === socket);
        if (index >= 0) {
          const wasVisible = index === 0;
          this.#pending.splice(index, 1);
          this.emit("abandoned", { requestId: request.requestId });
          if (wasVisible) this.#emitNext();
        }
      });
      if (this.#pending.length === 1) this.#emitNext();
    });
  }

  #emitNext() {
    const pending = this.#pending[0];
    if (pending) this.emit("request", { ...pending.request, pendingCount: this.#pending.length });
  }
}
