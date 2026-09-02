#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classifyApprovalRequest } from "./approval-policy.mjs";

const MAX_RESPONSE_BYTES = 64 * 1024;

function denied(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

export function requestDirectApproval(socketPath, payload, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const requestId = randomUUID();
    const socket = net.connect(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish({ decision: "deny", reason: "직접 승인 시간 초과" }), timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ requestId, payload })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_RESPONSE_BYTES) {
        finish({ decision: "deny", reason: "승인 응답이 너무 큽니다" });
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline));
        if (response.requestId !== requestId || !["approve", "deny"].includes(response.decision)) {
          finish({ decision: "deny", reason: "승인 응답 검증 실패" });
        } else {
          finish(response);
        }
      } catch {
        finish({ decision: "deny", reason: "승인 응답 JSON 오류" });
      }
    });
    socket.once("error", () => finish({ decision: "deny", reason: "포그라운드 승인 화면이 연결되어 있지 않습니다" }));
    socket.once("close", () => finish({ decision: "deny", reason: "승인 화면 연결이 종료됐습니다" }));
  });
}

export async function runApprovalGate({
  input = process.stdin,
  output = process.stdout,
  env = process.env,
} = {}) {
  let text = "";
  for await (const chunk of input) text += chunk.toString("utf8");
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    output.write(`${JSON.stringify(denied("PreToolUse 입력 JSON 오류"))}\n`);
    return 0;
  }
  const risk = classifyApprovalRequest(payload);
  if (!risk) return 0;
  const socketPath = env.WAGA_APPROVAL_SOCKET;
  if (!socketPath) {
    output.write(`${JSON.stringify(denied("포그라운드 승인 소켓이 설정되지 않았습니다"))}\n`);
    return 0;
  }
  const response = await requestDirectApproval(socketPath, payload);
  if (response.decision !== "approve") {
    output.write(`${JSON.stringify(denied(response.reason || "직접 사용자가 승인하지 않았습니다"))}\n`);
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  await runApprovalGate();
}
