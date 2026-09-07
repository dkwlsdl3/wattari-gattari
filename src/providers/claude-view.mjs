import fs from "node:fs/promises";
import path from "node:path";

const MAX_PROC_BYTES = 16 * 1024;
const PID = /^[1-9][0-9]*$/;

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
export async function retainedClaudeViewMatches(panePid, commandSpec, { readProc: read = readProc } = {}) {
  if (!PID.test(String(panePid))) return false;
  const childrenPath = `/proc/${panePid}/task/${panePid}/children`;
  try {
    const child = (await read(childrenPath)).trim();
    if (!PID.test(child)) return false;
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
