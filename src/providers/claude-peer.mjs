import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const PROTOCOL_VERSION = 1;

function processStart(pid) {
  try {
    return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function xmlEscape(value) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function safeMessageText(value) {
  return value.replace(/<\/cross-session-message\s*>/gi, "< /cross-session-message>");
}

function claudeVersionHint() {
  try {
    const output = execFileSync("claude", ["--version"], { encoding: "utf8" });
    return /^\d+\.\d+\.\d+/.exec(output.trim())?.[0] ?? "unknown";
  } catch {
    return "unknown";
  }
}

export function buildClaudeFrame({ text, fromSocket, messageId = crypto.randomUUID(), priority = "next" }) {
  return {
    msgV: PROTOCOL_VERSION,
    msg_id: messageId,
    type: "user",
    message: {
      role: "user",
      content: `<cross-session-message from="uds:${xmlEscape(fromSocket)}">\n${safeMessageText(text)}\n</cross-session-message>`,
    },
    priority,
    from: `uds:${fromSocket}`,
  };
}

export function parseClaudeFrame(line) {
  const frame = JSON.parse(line);
  const raw = typeof frame?.message?.content === "string" ? frame.message.content : "";
  const inner = raw.match(/<cross-session-message\b[^>]*>\n?([\s\S]*?)\n?<\/cross-session-message>/);
  return {
    type: frame?.type ?? null,
    messageId: frame?.msg_id ?? null,
    originalMessageId: frame?.orig_msg_id ?? null,
    from: frame?.from ?? null,
    fromSocket: typeof frame?.from === "string" ? frame.from.replace(/^uds:/, "") : null,
    text: (inner ? inner[1] : raw).trim(),
    held: frame?.wasHeld === true || frame?.wereHeld === true,
    dropped: Boolean(frame?.drop_reason) || (Array.isArray(frame?.dropped_msg_ids) && frame.dropped_msg_ids.length > 0),
    raw: frame,
  };
}

function assertPrivateDirectory(directory) {
  if (!path.isAbsolute(directory)) throw Object.assign(new Error("Claude socket directory must be absolute"), { code: "CLAUDE_SOCKET_DIR_INVALID" });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Object.assign(new Error(`Unsafe Claude socket directory: ${directory}`), { code: "CLAUDE_SOCKET_DIR_INVALID" });
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw Object.assign(new Error(`Claude socket directory is owned by uid ${stat.uid}`), { code: "CLAUDE_SOCKET_DIR_OWNER" });
  }
  if ((stat.mode & 0o022) !== 0) {
    throw Object.assign(new Error(`Claude socket directory is writable by another user: ${directory}`), { code: "CLAUDE_SOCKET_DIR_PERMISSIONS" });
  }
}

function assertTargetSocket(targetSocket, directory) {
  if (path.dirname(targetSocket) !== directory) throw Object.assign(new Error("Claude target is outside the selected socket directory"), { code: "CLAUDE_SOCKET_TARGET_INVALID" });
  const stat = fs.lstatSync(targetSocket);
  if (!stat.isSocket() || stat.isSymbolicLink()) throw Object.assign(new Error(`Claude target is not a Unix socket: ${targetSocket}`), { code: "CLAUDE_SOCKET_TARGET_INVALID" });
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw Object.assign(new Error(`Claude target socket is owned by uid ${stat.uid}`), { code: "CLAUDE_SOCKET_TARGET_OWNER" });
  }
}

export class ClaudePeerEndpoint {
  #home;
  #name;
  #cwd;
  #server = null;
  #socketPath = null;
  #registryPath = null;
  #keyPath = null;
  #records = [];
  #listeners = new Set();
  #exitCleanup;

  constructor({ homeDirectory = os.homedir(), name = `waga-${process.pid}`, cwd = process.cwd() } = {}) {
    this.#home = homeDirectory;
    this.#name = name;
    this.#cwd = cwd;
    this.#exitCleanup = () => this.#removeOwnedFiles();
  }

  get socketPath() { return this.#socketPath; }

  async start({ socketDirectory }) {
    if (this.#server) return;
    assertPrivateDirectory(socketDirectory);
    const sessionsDirectory = path.join(this.#home, ".claude", "sessions");
    fs.mkdirSync(sessionsDirectory, { recursive: true, mode: 0o700 });
    this.#socketPath = path.join(socketDirectory, `${process.pid}.sock`);
    this.#registryPath = path.join(sessionsDirectory, `${process.pid}.json`);
    if (fs.existsSync(this.#socketPath) || fs.existsSync(this.#registryPath)) {
      throw Object.assign(new Error(`Refusing to replace an existing Claude peer identity for pid ${process.pid}`), { code: "CLAUDE_PEER_COLLISION" });
    }

    const started = processStart(process.pid);
    const peerToken = crypto.randomBytes(16).toString("hex");
    const keyHash = crypto.createHash("sha256").update(`${peerToken}${started}`).digest("hex");
    this.#keyPath = path.join(sessionsDirectory, `${process.pid}.${keyHash}.key`);

    try {
      await new Promise((resolve, reject) => {
        this.#server = net.createServer((socket) => this.#accept(socket));
        this.#server.once("error", reject);
        this.#server.listen(this.#socketPath, resolve);
      });
      fs.chmodSync(this.#socketPath, 0o600);
      const now = Date.now();
      fs.writeFileSync(this.#registryPath, JSON.stringify({
        pid: process.pid,
        sessionId: crypto.randomUUID(),
        cwd: this.#cwd,
        startedAt: now,
        updatedAt: now,
        statusUpdatedAt: now,
        procStart: started,
        version: claudeVersionHint(),
        peerProtocol: PROTOCOL_VERSION,
        peerFeatures: [],
        kind: "interactive",
        entrypoint: "waga-bridge",
        messagingSocketPath: this.#socketPath,
        name: this.#name,
        nameSource: "derived",
        status: "idle",
      }), { mode: 0o600 });
      fs.writeFileSync(this.#keyPath, JSON.stringify({ peerToken, procStart: started }), { mode: 0o600 });
      process.once("exit", this.#exitCleanup);
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async send(targetSocket, text) {
    if (!this.#server || !this.#socketPath) throw Object.assign(new Error("Claude peer endpoint is not started"), { code: "CLAUDE_PEER_NOT_STARTED" });
    assertTargetSocket(targetSocket, path.dirname(this.#socketPath));
    const frame = buildClaudeFrame({ text, fromSocket: this.#socketPath });
    await new Promise((resolve, reject) => {
      const client = net.connect({ path: targetSocket }, () => {
        client.end(`${JSON.stringify(frame)}\n`, resolve);
      });
      client.once("error", reject);
    });
    return frame.msg_id;
  }

  waitForReply(targetSocket, messageId, { timeoutMs }) {
    const match = (record) => record.type === "user" && record.fromSocket === targetSocket;
    const existing = this.#records.find(match);
    if (existing) return Promise.resolve(existing);
    const rejected = this.#records.find((record) => (
      record.type === "peer_message_status" &&
      record.originalMessageId === messageId &&
      (record.held || record.dropped)
    ));
    if (rejected) {
      return Promise.reject(Object.assign(
        new Error(rejected.held ? "Claude held the peer message for user approval" : "Claude refused the peer message"),
        { code: rejected.held ? "MESSAGE_HELD" : "MESSAGE_REFUSED" },
      ));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(Object.assign(new Error(`Claude session did not reply within ${timeoutMs}ms`), { code: "TIMEOUT" }));
      }, timeoutMs);
      const unsubscribe = this.#listen((record) => {
        if (record.type === "peer_message_status" && record.originalMessageId === messageId && (record.held || record.dropped)) {
          clearTimeout(timer);
          unsubscribe();
          reject(Object.assign(new Error(record.held ? "Claude held the peer message for user approval" : "Claude refused the peer message"), { code: record.held ? "MESSAGE_HELD" : "MESSAGE_REFUSED" }));
          return;
        }
        if (!match(record)) return;
        clearTimeout(timer);
        unsubscribe();
        resolve(record);
      });
    });
  }

  async stop() {
    process.removeListener("exit", this.#exitCleanup);
    const server = this.#server;
    this.#server = null;
    if (server) await new Promise((resolve) => server.close(resolve));
    this.#removeOwnedFiles();
  }

  #listen(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #accept(socket) {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) {
        socket.destroy();
        return;
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let record;
        try { record = parseClaudeFrame(line); } catch { continue; }
        this.#records.push(record);
        for (const listener of [...this.#listeners]) listener(record);
      }
    });
  }

  #removeOwnedFiles() {
    for (const file of [this.#socketPath, this.#registryPath, this.#keyPath]) {
      if (!file) continue;
      try { fs.rmSync(file, { force: true }); } catch {}
    }
  }
}
