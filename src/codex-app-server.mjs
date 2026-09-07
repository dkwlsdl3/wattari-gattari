import path from "node:path";
import { WebSocket } from "ws";

import { VERSION } from "./product.mjs";

export class AppServerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class CodexAppServerClient {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #closed = false;
  #onServerRequest;
  #onNotification;

  constructor(socket, { onServerRequest = null, onNotification = null } = {}) {
    this.#socket = socket;
    this.#onServerRequest = onServerRequest;
    this.#onNotification = onNotification;
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.#failAll(new AppServerError("CODEX_WS_BINARY_MESSAGE", "Codex App Server sent a binary message"));
        return;
      }
      let message;
      try { message = JSON.parse(data.toString("utf8")); } catch { return; }
      this.#onMessage(message);
    });
    socket.on("error", (error) => this.#failAll(error));
    socket.on("close", () => {
      if (!this.#closed) this.#failAll(new AppServerError("CODEX_APP_SERVER_CLOSED", "Codex App Server connection closed"));
    });
  }

  static async connectUnixWebSocket({ socketPath, onServerRequest, onNotification } = {}) {
    if (typeof socketPath !== "string" || !path.isAbsolute(socketPath)) {
      throw new AppServerError("CODEX_SOCKET_PATH_INVALID", "Unix WebSocket path must be absolute");
    }
    const socket = new WebSocket(`ws+unix://${socketPath}:/`, { handshakeTimeout: 5_000, perMessageDeflate: false });
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    return new CodexAppServerClient(socket, { onServerRequest, onNotification });
  }

  async initialize({ signal, timeoutMs = 5_000 } = {}) {
    const result = await this.request("initialize", {
      clientInfo: { name: "waga", title: "Waga native session bridge", version: VERSION },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [
          "item/agentMessage/delta", "item/commandExecution/outputDelta", "item/fileChange/outputDelta",
          "item/plan/delta", "item/reasoning/summaryTextDelta", "item/reasoning/textDelta",
          "thread/realtime/item/transcript/delta", "thread/realtime/outputAudio/delta",
          "thread/realtime/transcript/delta",
        ],
      },
    }, { signal, timeoutMs });
    this.notify("initialized");
    return result;
  }

  request(method, params, { signal, timeoutMs = 30_000 } = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) return reject(new TypeError("RPC timeout must be between 0 and 2147483647ms"));
      const timer = setTimeout(() => {
        this.#pending.get(id)?.reject(new AppServerError("CODEX_RPC_TIMEOUT", `Codex RPC ${method} timed out; submission outcome may be unknown`));
        this.#pending.delete(id);
      }, timeoutMs);
      const abort = () => { clearTimeout(timer); this.#pending.delete(id); reject(signal.reason ?? new Error("aborted")); };
      signal?.addEventListener("abort", abort, { once: true });
      this.#pending.set(id, {
        resolve: (value) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(value); },
        reject: (error) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(error); },
      });
      try {
        this.#send({ method, id, params });
      } catch (error) {
        this.#pending.get(id)?.reject(error);
        this.#pending.delete(id);
      }
    });
  }

  notify(method, params) { this.#send(params === undefined ? { method } : { method, params }); }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new AppServerError("CODEX_APP_SERVER_CLOSED", "Codex App Server client closed"));
    if (this.#socket.readyState === WebSocket.CLOSED) return;
    if (this.#socket.readyState === WebSocket.CLOSING) { this.#socket.terminate(); return; }
    await new Promise((resolve) => {
      const timer = setTimeout(() => { this.#socket.terminate(); resolve(); }, 1_000);
      this.#socket.once("close", () => { clearTimeout(timer); resolve(); });
      this.#socket.close();
    });
  }

  #send(message) {
    if (this.#closed || this.#socket.readyState !== WebSocket.OPEN) {
      throw new AppServerError("CODEX_APP_SERVER_CLOSED", "Codex App Server client is not open");
    }
    this.#socket.send(JSON.stringify(message), (error) => { if (error) this.#failAll(error); });
  }

  #onMessage(message) {
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new AppServerError("CODEX_APP_SERVER_ERROR", `${message.error.code}: ${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.method && message.id !== undefined) { void this.#handleServerRequest(message); return; }
    if (message.method) this.#onNotification?.({ method: message.method, params: message.params });
  }

  async #handleServerRequest(message) {
    let response;
    try {
      let result = this.#onServerRequest ? await this.#onServerRequest({ method: message.method, params: message.params }) : undefined;
      if (result === undefined) result = deniedServerRequest(message.method);
      if (result === null) throw new AppServerError("METHOD_NOT_FOUND", `Waga does not handle server request ${message.method}`);
      response = { id: message.id, result };
    } catch (error) {
      response = { id: message.id, error: { code: -32603, message: error.message } };
    }
    try {
      this.#send(response);
    } catch (error) {
      this.#failAll(error);
    }
  }

  #failAll(error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function deniedServerRequest(method) {
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") return { decision: "decline" };
  if (method === "item/permissions/requestApproval") return { permissions: {}, scope: "turn" };
  if (method === "mcpServer/elicitation/request") return { action: "decline", content: null, _meta: null };
  if (method === "execCommandApproval" || method === "applyPatchApproval") return { decision: { denied: { rejection: "Direct user approval was not provided" } } };
  if (method === "item/tool/requestUserInput") return { answers: {} };
  if (method === "item/tool/call") return { success: false, contentItems: [{ type: "text", text: "Waga exposes no dynamic tools" }] };
  return null;
}
