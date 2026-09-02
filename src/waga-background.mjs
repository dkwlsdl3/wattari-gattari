import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { appPaths } from "./app-paths.mjs";
import { ControlClient } from "./control-client.mjs";
import { DAEMON_PROTOCOL_VERSION, VERSION } from "./product.mjs";
import { openRotatingLog } from "./rotating-log.mjs";

export const DAEMON_ENTRY_PATH = fileURLToPath(new URL("./waga-daemon.mjs", import.meta.url));

function probeSocket(socketPath) {
  return new Promise((resolve) => {
    const socket = net.connect(socketPath);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

async function inspectDaemon(socketPath) {
  const client = new ControlClient(socketPath);
  await client.connect();
  try {
    return await client.request("state/get");
  } finally {
    client.close();
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(pidPath) {
  if (!fs.existsSync(pidPath)) return null;
  const pid = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10);
  return Number.isInteger(pid) && pid > 1 ? pid : null;
}

function spawnDaemon({ logPath }) {
  const logFd = openRotatingLog(logPath);
  try {
    const child = spawn(process.execPath, [DAEMON_ENTRY_PATH], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(logFd);
  }
}

export function migrateLegacyState(paths = appPaths()) {
  fs.mkdirSync(paths.stateDirectory, { recursive: true, mode: 0o700 });
  const migrations = [
    [paths.catalogPath, paths.legacyStatePaths?.catalogPath, paths.legacyCatalogPath],
    [paths.claudeAliasCatalogPath, paths.legacyStatePaths?.claudeAliasCatalogPath],
    [paths.workspaceRegistryPath, paths.legacyStatePaths?.workspaceRegistryPath],
  ];
  let migrated = false;
  for (const [target, ...sources] of migrations) {
    if (fs.existsSync(target)) continue;
    const source = sources.find((candidate) => candidate && fs.existsSync(candidate));
    if (!source) continue;
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o600);
    migrated = true;
  }
  return migrated;
}

export async function ensureWagaDaemon({
  paths = appPaths(),
  probe = probeSocket,
  inspect = inspectDaemon,
  startDaemon = spawnDaemon,
  alive = processExists,
} = {}) {
  fs.mkdirSync(paths.runtimeDirectory, { recursive: true, mode: 0o700 });
  migrateLegacyState(paths);
  if (await probe(paths.controlSocketPath)) {
    const state = await inspect(paths.controlSocketPath);
    if (state?.version !== VERSION || state?.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
      throw Object.assign(new Error(`실행 중인 waga daemon(${state?.version ?? "unknown"}, protocol ${state?.protocolVersion ?? "unknown"})과 설치된 코드(${VERSION}, protocol ${DAEMON_PROTOCOL_VERSION})가 다릅니다. waga stop 후 다시 실행하십시오.`), {
        code: "DAEMON_VERSION_MISMATCH",
      });
    }
    return { started: false, version: state.version, protocolVersion: state.protocolVersion, ...paths };
  }
  const previousPid = readPid(paths.daemonPidPath);
  if (previousPid && alive(previousPid)) {
    throw new Error(`waga daemon ${previousPid} exists but its control socket is unavailable`);
  }
  if (fs.existsSync(paths.controlSocketPath)) {
    throw new Error(`Refusing to replace an unreachable control socket: ${paths.controlSocketPath}`);
  }
  if (previousPid) fs.unlinkSync(paths.daemonPidPath);

  const pid = startDaemon({ logPath: paths.daemonLogPath });
  if (!Number.isInteger(pid) || pid <= 1) throw new Error("waga daemon did not return a valid pid");
  fs.writeFileSync(paths.daemonPidPath, `${pid}\n`, { mode: 0o600 });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await probe(paths.controlSocketPath)) {
      const state = await inspect(paths.controlSocketPath);
      if (state?.version !== VERSION || state?.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
        throw new Error(`Started daemon reported unexpected identity: ${state?.version ?? "unknown"}, protocol ${state?.protocolVersion ?? "unknown"}`);
      }
      return { started: true, pid, version: state.version, protocolVersion: state.protocolVersion, ...paths };
    }
    if (!alive(pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`waga daemon failed to open ${paths.controlSocketPath}; see ${paths.daemonLogPath}`);
}

export async function stopWagaDaemon({
  paths = appPaths(),
  probe = probeSocket,
  alive = processExists,
  readCommandLine = (pid) => fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean),
  requestShutdown = async () => {
    const client = new ControlClient(paths.controlSocketPath);
    await client.connect();
    try {
      return await client.request("daemon/shutdown");
    } finally {
      client.close();
    }
  },
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const pid = readPid(paths.daemonPidPath);
  if (!pid) {
    if (await probe(paths.controlSocketPath)) throw new Error("Refusing to stop an unowned control socket");
    return { stopped: false, pid: null };
  }
  if (!alive(pid) && !(await probe(paths.controlSocketPath))) {
    fs.unlinkSync(paths.daemonPidPath);
    return { stopped: false, pid };
  }
  const commandLine = readCommandLine(pid);
  if (!commandLine.includes(DAEMON_ENTRY_PATH)) throw new Error(`Refusing to stop unverified daemon process ${pid}`);
  await requestShutdown();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!alive(pid) && !(await probe(paths.controlSocketPath))) {
      if (fs.existsSync(paths.daemonPidPath)) fs.unlinkSync(paths.daemonPidPath);
      return { stopped: true, pid };
    }
    await wait(50);
  }
  throw new Error(`waga daemon ${pid} did not stop`);
}
