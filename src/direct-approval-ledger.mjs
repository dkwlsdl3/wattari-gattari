import { classifyApprovalRequest } from "./approval-policy.mjs";

const DEFAULT_TTL_MS = 15_000;

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function requestKey(threadId, turnId, itemId) {
  return JSON.stringify([threadId, turnId, itemId]);
}

function grantFromHook(payload, expiresAt) {
  if (
    payload?.hook_event_name !== "PreToolUse"
    || !nonEmptyString(payload.session_id)
    || !nonEmptyString(payload.turn_id)
    || !nonEmptyString(payload.tool_use_id)
    || !classifyApprovalRequest(payload)
  ) {
    return null;
  }

  const base = {
    threadId: payload.session_id,
    turnId: payload.turn_id,
    itemId: payload.tool_use_id,
    expiresAt,
  };
  if (payload.tool_name === "Bash" && nonEmptyString(payload.tool_input?.command)) {
    return {
      ...base,
      method: "item/commandExecution/requestApproval",
      kind: "command",
      command: payload.tool_input.command,
      cwd: payload.cwd,
    };
  }
  if (payload.tool_name === "write_stdin") {
    return {
      ...base,
      method: "item/commandExecution/requestApproval",
      kind: "writeStdin",
    };
  }
  if (payload.tool_name === "apply_patch") {
    return { ...base, method: "item/fileChange/requestApproval" };
  }
  return null;
}

function matches(grant, request) {
  if (request.method !== grant.method) return false;
  const params = request.params;
  if (!params || typeof params !== "object") return false;
  if (
    params.threadId !== grant.threadId
    || params.turnId !== grant.turnId
    || params.itemId !== grant.itemId
  ) {
    return false;
  }
  if (grant.method !== "item/commandExecution/requestApproval") return true;
  if (params.kind !== grant.kind) return false;
  if (grant.kind === "writeStdin") return true;
  return params.command === grant.command && params.cwd === grant.cwd;
}

export class DirectApprovalLedger {
  #grants = new Map();
  #now;
  #ttlMs;

  constructor({ ttlMs = DEFAULT_TTL_MS, now = Date.now } = {}) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError("Approval ttl must be positive");
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  authorizeHook(payload) {
    this.#removeExpired();
    const grant = grantFromHook(payload, this.#now() + this.#ttlMs);
    if (!grant) return false;
    this.#grants.set(requestKey(grant.threadId, grant.turnId, grant.itemId), grant);
    return true;
  }

  consumeServerRequest(request) {
    this.#removeExpired();
    const params = request?.params;
    if (!params || typeof params !== "object") return undefined;
    const key = requestKey(params.threadId, params.turnId, params.itemId);
    const grant = this.#grants.get(key);
    if (!grant) return undefined;
    this.#grants.delete(key);
    return matches(grant, request) ? { decision: "accept" } : undefined;
  }

  #removeExpired() {
    const now = this.#now();
    for (const [key, grant] of this.#grants) {
      if (grant.expiresAt < now) this.#grants.delete(key);
    }
  }
}
