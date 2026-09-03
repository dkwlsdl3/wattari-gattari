import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { buildPeerEnvelope } from "../bridge/envelope.mjs";
import { ClaudePeerEndpoint } from "./claude-peer.mjs";

const execFileAsync = promisify(execFile);
const SHORT_ID = /^[0-9a-f]{8}$/i;

async function defaultRun(args, { cwd } = {}) {
  return execFileAsync("claude", args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 30_000 });
}

function canonical(value) {
  const resolved = path.resolve(value);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function claudeProjectCwd(value) {
  const cwd = canonical(value);
  const worktreeMarker = `${path.sep}.claude${path.sep}worktrees${path.sep}`;
  const markerIndex = cwd.indexOf(worktreeMarker);
  return markerIndex > 0 ? cwd.slice(0, markerIndex) : cwd;
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

export function parseClaudeAgents(stdout) {
  let rows;
  try { rows = JSON.parse(stdout); } catch (cause) {
    throw Object.assign(new Error("Claude agents did not return valid JSON", { cause }), { code: "CLAUDE_AGENTS_INVALID" });
  }
  if (!Array.isArray(rows) || rows.some((row) => !row || !SHORT_ID.test(row.id) || typeof row.sessionId !== "string" || typeof row.cwd !== "string")) {
    throw Object.assign(new Error("Claude agents JSON does not match the expected session array"), { code: "CLAUDE_AGENTS_INVALID" });
  }
  return rows;
}

function statusOf(row) {
  if (row.status === "busy" || row.state === "working") return "working";
  if (row.status === "waiting") return "needs-input";
  if (row.status === "idle") return "idle";
  return "unavailable";
}

export class ClaudeProvider {
  name = "claude";
  #home;
  #run;
  #endpointFactory;
  #wait;
  #now;

  constructor({ homeDirectory = os.homedir(), run = defaultRun, endpointFactory, wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)), now = Date.now } = {}) {
    this.#home = homeDirectory;
    this.#run = run;
    this.#endpointFactory = endpointFactory ?? ((options) => new ClaudePeerEndpoint(options));
    this.#wait = wait;
    this.#now = now;
  }

  async list({ cwd } = {}) {
    const expectedCwd = cwd ? canonical(cwd) : null;
    const args = ["agents", "--json"];
    if (expectedCwd) args.push("--cwd", expectedCwd);
    const { stdout } = await this.#run(args, { cwd: expectedCwd ?? undefined });
    const sessions = [];
    for (const row of parseClaudeAgents(stdout)) {
      if (!processAlive(row.pid)) continue;
      let registry;
      try { registry = JSON.parse(fs.readFileSync(path.join(this.#home, ".claude", "sessions", `${row.pid}.json`), "utf8")); } catch { continue; }
      if (registry.pid !== row.pid || registry.sessionId !== row.sessionId || registry.peerProtocol !== 1) continue;
      if (typeof registry.messagingSocketPath !== "string" || !path.isAbsolute(registry.messagingSocketPath)) continue;
      try { if (!fs.lstatSync(registry.messagingSocketPath).isSocket()) continue; } catch { continue; }
      const sessionCwd = canonical(row.cwd);
      sessions.push({
        id: `claude:${row.sessionId}`,
        nativeId: row.id,
        sessionId: row.sessionId,
        provider: this.name,
        name: row.name ?? registry.name ?? row.id,
        cwd: sessionCwd,
        projectCwd: expectedCwd ?? claudeProjectCwd(sessionCwd),
        status: statusOf(row),
        updatedAt: Number(row.startedAt ?? registry.updatedAt ?? 0),
        socketPath: registry.messagingSocketPath,
      });
    }
    return sessions;
  }

  async send(session, message, { requestId }) {
    const endpoint = this.#endpointFactory({ homeDirectory: this.#home, cwd: process.cwd() });
    try {
      await endpoint.start({ socketDirectory: path.dirname(session.socketPath) });
      const messageId = await endpoint.send(session.socketPath, buildPeerEnvelope({ message, requestId, expectsReply: false }));
      const disposition = await endpoint.waitForDisposition(messageId, { timeoutMs: 150 });
      return { target: session.id, requestId, messageId, delivery: disposition.state };
    } finally {
      await endpoint.stop();
    }
  }

  async ask(session, message, { requestId, waitTimeoutMs, replyTimeoutMs, timeoutMs, onProgress = () => {} }) {
    const fallbackTimeout = timeoutMs ?? 180_000;
    const current = await this.#waitUntilIdle(session, {
      timeoutMs: waitTimeoutMs ?? fallbackTimeout,
      onProgress,
    });
    const endpoint = this.#endpointFactory({ homeDirectory: this.#home, cwd: process.cwd() });
    try {
      await endpoint.start({ socketDirectory: path.dirname(current.socketPath) });
      const messageId = await endpoint.send(current.socketPath, buildPeerEnvelope({ message, requestId, expectsReply: true }));
      onProgress({ state: "submitted", target: session.id });
      const reply = await endpoint.waitForReply(current.socketPath, messageId, { timeoutMs: replyTimeoutMs ?? fallbackTimeout });
      onProgress({ state: "replied", target: session.id });
      return { target: session.id, requestId, messageId, reply: reply.text, exchangeCount: 1, autoForwarded: false };
    } finally {
      await endpoint.stop();
    }
  }

  async #waitUntilIdle(session, { timeoutMs, onProgress }) {
    const deadline = this.#now() + timeoutMs;
    let waiting = false;
    let pollIntervalMs = 500;
    while (true) {
      const sessions = await this.list({ cwd: session.projectCwd });
      const current = sessions.find((candidate) => candidate.id === session.id || candidate.sessionId === session.sessionId);
      if (!current) throw Object.assign(new Error(`Claude target is unavailable: ${session.id}`), { code: "TARGET_UNAVAILABLE" });
      if (current.status !== "working") return current;
      if (!waiting) { onProgress({ state: "waiting", target: session.id }); waiting = true; }
      if (this.#now() >= deadline) throw Object.assign(new Error(`Claude target stayed busy for ${timeoutMs}ms`), { code: "TARGET_BUSY_TIMEOUT" });
      await this.#wait(Math.min(pollIntervalMs, Math.max(1, deadline - this.#now())));
      pollIntervalMs = Math.min(5_000, pollIntervalMs * 2);
    }
  }
}
