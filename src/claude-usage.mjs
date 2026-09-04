import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const MAX_RESPONSE_BYTES = 1024 * 1024;

function parseWindow(window) {
  if (!Number.isFinite(window?.utilization)) return null;
  const usedPercent = Math.max(0, Math.min(100, Math.round(window.utilization)));
  const resetMilliseconds = typeof window.resets_at === "string" ? Date.parse(window.resets_at) : Number.NaN;
  return {
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt: Number.isNaN(resetMilliseconds) ? null : Math.floor(resetMilliseconds / 1_000),
  };
}

export function parseClaudeUsage(result, observedAt = Date.now()) {
  const fiveHour = parseWindow(result?.five_hour);
  const weekly = parseWindow(result?.seven_day);
  if (!fiveHour && !weekly) return null;
  return { fiveHour, weekly, observedAt };
}

function curlUsage(accessToken) {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", [
      "--silent",
      "--show-error",
      "--max-time", "10",
      "--config", "-",
      "--write-out", "\n%{http_code}",
      CLAUDE_USAGE_URL,
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_RESPONSE_BYTES) child.kill();
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(`Claude usage request failed: ${stderr.trim() || `curl exited ${code}`}`));
      const marker = stdout.lastIndexOf("\n");
      if (marker < 0) return reject(new Error("Claude usage response is missing its HTTP status"));
      resolve({ status: Number(stdout.slice(marker + 1)), body: stdout.slice(0, marker) });
    });
    child.stdin.end([
      `header = "Authorization: Bearer ${accessToken}"`,
      'header = "anthropic-beta: oauth-2025-04-20"',
      'header = "Content-Type: application/json"',
      "",
    ].join("\n"));
  });
}

export async function readClaudeUsage({ homeDirectory = os.homedir(), now = Date.now, request = curlUsage } = {}) {
  try {
    const credentials = JSON.parse(await fs.readFile(path.join(homeDirectory, ".claude", ".credentials.json"), "utf8"));
    const oauth = credentials?.claudeAiOauth;
    if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) return null;
    if (/[\r\n"]/u.test(oauth.accessToken)) return null;
    if (Number.isFinite(oauth.expiresAt) && now() >= oauth.expiresAt - 60_000) return null;
    const response = await request(oauth.accessToken);
    if (response.status !== 200) return null;
    return parseClaudeUsage(JSON.parse(response.body), now());
  } catch {
    return null;
  }
}
