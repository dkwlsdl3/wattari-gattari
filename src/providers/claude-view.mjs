import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_PROC_BYTES = 16 * 1024;
const PID = /^[1-9][0-9]*$/;

export async function claudeInteractiveRegistryMatches(id, pid, env = process.env) {
  if (typeof id !== "string" || !id.startsWith("claude:") || !PID.test(String(pid))) return false;
  const directory = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  try {
    const registry = JSON.parse(await fs.readFile(path.join(directory, "sessions", `${pid}.json`), "utf8"));
    // A parked original keeps its UUID after native Left; the job now owns the conversation.
    return registry.pid === Number(pid) && `claude:${registry.sessionId}` === id && !registry.parkedJobId;
  } catch (error) { return error.code === "ENOENT"; } // Startup prompts precede the native registry.
}

async function readProc(file) {
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(MAX_PROC_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_PROC_BYTES) throw new Error("Process identity exceeds read limit");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

// Claude 2.1.263 relaunches `attach <id>` as `agents` on native Left.
// Only a matching leaf frontend proves this retained window is still on target.
// Missing /proc, wrappers and fork-based relaunches conservatively require reattach.
export async function claudeInteractivePid(panePid) {
  if (!PID.test(String(panePid))) return null;
  try {
    const children = `/proc/${panePid}/task/${panePid}/children`;
    const pid = (await readProc(children)).trim();
    return PID.test(pid) && (await readProc(children)).trim() === pid ? Number(pid) : null;
  } catch { return null; }
}

export async function retainedClaudeViewMatches(panePid, commandSpec, { readProc: read = readProc, env = process.env } = {}) {
  if (!PID.test(String(panePid))) return false;
  const childrenPath = `/proc/${panePid}/task/${panePid}/children`;
  try {
    const child = (await read(childrenPath)).trim();
    if (!PID.test(child)) return false;
    if (commandSpec.reuseOnly) {
      // The native registry PID is the original CLI, not an attach frontend.
      // Do not inspect argv or replace a CLI waiting for its usage limit reset.
      return child === String(commandSpec.interactivePid)
        && await claudeInteractiveRegistryMatches(commandSpec.interactiveId, child, env)
        && (await read(childrenPath)).trim() === child;
    }
    const cmdline = await read(`/proc/${child}/cmdline`);
    if (!cmdline.endsWith("\0")) return false;
    const argv = cmdline.slice(0, -1).split("\0");
    if (path.basename(argv[0]) !== path.basename(commandSpec.command)
      || argv.length !== commandSpec.args.length + 1
      || commandSpec.args.some((arg, index) => argv[index + 1] !== arg)) return false;
    if ((await read(`/proc/${child}/task/${child}/children`)).trim()) return false;
    return (await read(childrenPath)).trim() === child;
  } catch { return false; }
}
