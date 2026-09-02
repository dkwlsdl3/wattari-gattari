import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { VERSION } from "./product.mjs";

import { readJsonLines, writeJsonLine } from "./line-json.mjs";

const SHADOW_DISABLED_FEATURES = [
  "apps",
  "browser_use",
  "computer_use",
  "hooks",
  "image_generation",
  "multi_agent",
  "plugins",
];
export const APPROVAL_GATE_PATH = fileURLToPath(new URL("./approval-gate.mjs", import.meta.url));
export const APPROVAL_HOOK_MATCHER = "^(Bash|apply_patch|write_stdin|request_permissions)$";

function safeAppServerArgs({ mcpServerNames, disabledFeatures }) {
  const args = [
    "-c",
    "mcp_servers={}",
    "-c",
    "web_search=\"live\"",
    "-c",
    "tools.web_search=true",
  ];
  for (const name of mcpServerNames) {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      throw new AppServerError("CODEX_MCP_NAME_UNSAFE", `Cannot safely override MCP server name: ${name}`);
    }
    args.push("-c", `mcp_servers.${name}.enabled=false`);
  }
  for (const feature of disabledFeatures) args.push("--disable", feature);
  return args;
}

export function managedApprovalHookOverride() {
  const command = `node ${JSON.stringify(APPROVAL_GATE_PATH)}`;
  return `hooks.PreToolUse=[{matcher=${JSON.stringify(APPROVAL_HOOK_MATCHER)},hooks=[{type="command",command=${JSON.stringify(command)},timeout=130,statusMessage="waga 직접 승인 확인"}]}]`;
}

export function configuredMcpServerNames(configText) {
  const names = new Set();
  for (const line of configText.split(/\r?\n/)) {
    if (!/^\s*\[\s*mcp_servers(?:\.|\s*\])/.test(line)) continue;
    const match = /^\s*\[\s*mcp_servers\.([A-Za-z0-9_-]+)(?:\.[^\]]+)?\s*\]\s*(?:#.*)?$/.exec(line);
    if (!match) {
      throw new AppServerError(
        "CODEX_MCP_CONFIG_UNSUPPORTED",
        `Cannot safely disable MCP configuration declared as: ${line.trim()}`,
      );
    }
    names.add(match[1]);
  }
  return [...names];
}

export function shadowAppServerArgs({ mcpServerNames = [] } = {}) {
  return [
    "app-server",
    "--stdio",
    ...safeAppServerArgs({ mcpServerNames, disabledFeatures: SHADOW_DISABLED_FEATURES }),
  ];
}

export function managedAppServerArgs(socketPath, { mcpServerNames = [] } = {}) {
  if (typeof socketPath !== "string" || !path.isAbsolute(socketPath)) {
    throw new AppServerError("CODEX_SOCKET_PATH_INVALID", "Managed App Server socket path must be absolute");
  }
  const disabledFeatures = SHADOW_DISABLED_FEATURES.filter((feature) => feature !== "hooks");
  return [
    "--dangerously-bypass-hook-trust",
    "app-server",
    "--listen",
    `unix://${socketPath}`,
    ...safeAppServerArgs({ mcpServerNames, disabledFeatures }),
    "--enable",
    "hooks",
    "-c",
    managedApprovalHookOverride(),
  ];
}

class AppServerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function webSocketChild(webSocket) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      try {
        for (const line of chunk.toString("utf8").split(/\r?\n/)) {
          if (line) webSocket.send(line);
        }
        callback();
      } catch (error) {
        callback(error);
      }
    },
    final(callback) {
      webSocket.close();
      callback();
    },
  });
  child.kill = () => webSocket.terminate();
  webSocket.on("message", (data, isBinary) => {
    if (isBinary) {
      child.emit("error", new AppServerError("CODEX_WS_BINARY_MESSAGE", "Codex App Server sent a binary message"));
      return;
    }
    child.stdout.write(`${data.toString("utf8")}\n`);
  });
  webSocket.on("error", (error) => child.emit("error", error));
  webSocket.on("close", () => {
    child.exitCode = 0;
    child.stdout.end();
    child.stderr.end();
    child.emit("exit", 0, null);
  });
  return child;
}

export class CodexAppServerClient {
  #child;
  #nextId = 1;
  #pending = new Map();
  #notificationWaiters = new Set();
  #stderr = "";
  #closed = false;
  #onServerRequest;
  #onNotification;

  constructor(child, { onServerRequest = null, onNotification = null } = {}) {
    this.#child = child;
    this.#onServerRequest = onServerRequest;
    this.#onNotification = onNotification;
    child.stderr?.on("data", (chunk) => {
      this.#stderr = (this.#stderr + chunk.toString("utf8")).slice(-16 * 1024);
    });
    readJsonLines(child.stdout, (message) => this.#onMessage(message));
    child.once("error", (error) => this.#failAll(error));
    child.once("exit", (code, signal) => {
      if (this.#closed) return;
      this.#failAll(new AppServerError(
        "CODEX_APP_SERVER_EXITED",
        `Codex App Server exited (${signal ?? code})${this.#stderr ? `: ${this.#stderr.trim()}` : ""}`,
      ));
    });
  }

  static spawn({
    cwd,
    onServerRequest,
    onNotification,
    configPath = path.join(os.homedir(), ".codex", "config.toml"),
    mcpServerNames,
  } = {}) {
    const configuredNames = mcpServerNames ?? (
      fs.existsSync(configPath)
        ? configuredMcpServerNames(fs.readFileSync(configPath, "utf8"))
        : []
    );
    const child = spawn("codex", shadowAppServerArgs({ mcpServerNames: configuredNames }), {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new CodexAppServerClient(child, { onServerRequest, onNotification });
  }

  static spawnDaemonProxy({ cwd, socketPath, onServerRequest, onNotification } = {}) {
    const args = ["app-server", "proxy"];
    if (socketPath) args.push("--sock", socketPath);
    const child = spawn("codex", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return new CodexAppServerClient(child, { onServerRequest, onNotification });
  }

  static async connectUnixWebSocket({ socketPath, onServerRequest, onNotification } = {}) {
    if (typeof socketPath !== "string" || !path.isAbsolute(socketPath)) {
      throw new AppServerError("CODEX_SOCKET_PATH_INVALID", "Unix WebSocket path must be absolute");
    }
    const webSocket = new WebSocket(`ws+unix://${socketPath}:/`, {
      handshakeTimeout: 5_000,
      perMessageDeflate: false,
    });
    await new Promise((resolve, reject) => {
      webSocket.once("open", resolve);
      webSocket.once("error", reject);
    });
    return new CodexAppServerClient(webSocketChild(webSocket), { onServerRequest, onNotification });
  }

  async initialize({ signal } = {}) {
    const result = await this.request("initialize", {
      clientInfo: { name: "waga", title: "waga shadow worker", version: VERSION },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [
          "item/agentMessage/delta",
          "item/commandExecution/outputDelta",
          "item/fileChange/outputDelta",
          "item/plan/delta",
          "item/reasoning/summaryTextDelta",
          "item/reasoning/textDelta",
          "thread/realtime/item/transcript/delta",
          "thread/realtime/outputAudio/delta",
          "thread/realtime/transcript/delta",
        ],
      },
    }, { signal });
    this.notify("initialized");
    return result;
  }

  request(method, params, { signal } = {}) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      const abort = () => {
        this.#pending.delete(id);
        reject(signal.reason ?? new Error("aborted"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.#pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
      writeJsonLine(this.#child.stdin, { method, id, params });
    });
  }

  notify(method, params) {
    writeJsonLine(this.#child.stdin, params === undefined ? { method } : { method, params });
  }

  waitForNotification(method, predicate, { signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("aborted"));
        return;
      }
      const waiter = { method, predicate, resolve, reject, signal, abort: null };
      waiter.abort = () => {
        this.#notificationWaiters.delete(waiter);
        reject(signal.reason ?? new Error("aborted"));
      };
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.#notificationWaiters.add(waiter);
    });
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new AppServerError("CODEX_APP_SERVER_CLOSED", "Codex App Server client closed"));
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return;
    this.#child.stdin.end();
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#child.kill("SIGTERM");
      }, 1_000);
      this.#child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #onMessage(message) {
    if (message.id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new AppServerError(
          "CODEX_APP_SERVER_ERROR",
          `${message.error.code}: ${message.error.message}`,
        ));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && message.id !== undefined) {
      this.#handleServerRequest(message);
      return;
    }

    if (!message.method) return;
    this.#onNotification?.({ method: message.method, params: message.params });
    for (const waiter of [...this.#notificationWaiters]) {
      if (waiter.method !== message.method || !waiter.predicate(message.params)) continue;
      this.#notificationWaiters.delete(waiter);
      waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.resolve(message.params);
    }
  }

  async #handleServerRequest(message) {
    try {
      if (!this.#onServerRequest) {
        const decision = defaultDeniedServerRequest(message.method);
        if (decision) {
          writeJsonLine(this.#child.stdin, { id: message.id, result: decision });
          return;
        }
        throw new AppServerError("METHOD_NOT_FOUND", `waga does not handle server request ${message.method}`);
      }
      let result = await this.#onServerRequest({ method: message.method, params: message.params });
      if (result === undefined) {
        result = defaultDeniedServerRequest(message.method);
        if (!result) {
          throw new AppServerError("METHOD_NOT_FOUND", `waga does not handle server request ${message.method}`);
        }
      }
      writeJsonLine(this.#child.stdin, { id: message.id, result });
    } catch (error) {
      writeJsonLine(this.#child.stdin, {
        id: message.id,
        error: { code: -32603, message: error.message },
      });
    }
  }

  #failAll(error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
    for (const waiter of this.#notificationWaiters) {
      waiter.signal?.removeEventListener("abort", waiter.abort);
      waiter.reject(error);
    }
    this.#notificationWaiters.clear();
  }
}

function defaultDeniedServerRequest(method) {
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    return { decision: "decline" };
  }
  if (method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn" };
  }
  if (method === "mcpServer/elicitation/request") {
    return { action: "decline", content: null, _meta: null };
  }
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    return { decision: { denied: { rejection: "Direct user approval was not provided" } } };
  }
  if (method === "item/tool/requestUserInput") {
    return { answers: {} };
  }
  if (method === "item/tool/call") {
    return {
      success: false,
      contentItems: [{ type: "text", text: "waga exposes no dynamic tools" }],
    };
  }
  return null;
}
