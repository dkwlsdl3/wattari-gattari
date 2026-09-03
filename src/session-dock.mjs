import { DirectWorkspace } from "./direct-workspace.mjs";
import { runOverview } from "./overview.mjs";
import { enterWagaDock } from "./tmux-workspace.mjs";

export async function enterDirectDock({
  cwd = process.cwd(),
  filterCwd = null,
  bridge,
  inputStream = process.stdin,
  outputStream = process.stdout,
  errorOutput = process.stderr,
  overview = runOverview,
  workspace = new DirectWorkspace({ inputStream, outputStream, errorOutput }),
} = {}) {
  const code = await overview({
    filterCwd,
    defaultCwd: cwd,
    bridge,
    workspace,
    inputStream,
    outputStream,
    errorOutput,
    nativeHint: "복귀: Claude Ctrl+Z   Codex Ctrl+D",
  });
  return { code, mode: "direct" };
}

export async function enterSessionDock({
  backend = "auto",
  enterTmux = enterWagaDock,
  enterDirect = enterDirectDock,
  ...options
} = {}) {
  if (backend === "direct") return enterDirect(options);
  if (backend === "tmux") return enterTmux(options);
  if (backend !== "auto") throw Object.assign(new Error(`Unknown backend: ${backend}`), { code: "INVALID_ARGUMENT" });

  try {
    return await enterTmux(options);
  } catch (error) {
    if (error.code !== "TMUX_UNAVAILABLE") throw error;
    return enterDirect(options);
  }
}
