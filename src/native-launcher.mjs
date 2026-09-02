import { spawn } from "node:child_process";
import path from "node:path";

function defaultLaunch(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal }));
  });
}

export async function openNativeAgents(provider, { cwd = process.cwd(), launch = defaultLaunch } = {}) {
  const workspace = path.resolve(cwd);
  const command = provider === "claude" ? "claude" : provider === "codex" ? "codex" : null;
  if (!command) throw Object.assign(new Error(`Unknown provider: ${provider}`), { code: "PROVIDER_NOT_FOUND" });
  const args = provider === "claude" ? ["agents", "--cwd", workspace] : ["agents", "-C", workspace];
  return launch(command, args, { cwd: workspace });
}
