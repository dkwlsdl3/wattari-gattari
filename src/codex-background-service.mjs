import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  configuredMcpServerNames,
  managedAppServerArgs,
} from "./codex-app-server.mjs";
import { appPaths } from "./app-paths.mjs";
import { openRotatingLog } from "./rotating-log.mjs";

export function managedCodexPaths(env = process.env) {
  const paths = appPaths(env);
  const directory = paths.runtimeDirectory;
  return {
    directory,
    socketPath: paths.socketPath,
    pidPath: paths.pidPath,
    logPath: paths.logPath,
    catalogPath: paths.catalogPath,
    approvalSocketPath: paths.approvalSocketPath,
  };
}

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

function readProcessCommandLine(pid) {
  return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
}

function isManagedAppServerCommand(commandLine, socketPath) {
  const appServerIndex = commandLine.indexOf("app-server");
  const listenIndex = commandLine.indexOf("--listen");
  return appServerIndex >= 0
    && listenIndex > appServerIndex
    && commandLine[listenIndex + 1] === `unix://${socketPath}`;
}

function removeRuntimeEndpoint(paths) {
  if (fs.existsSync(paths.pidPath)) fs.unlinkSync(paths.pidPath);
  if (fs.existsSync(paths.socketPath)) fs.unlinkSync(paths.socketPath);
}

function spawnBackgroundServer(args, { cwd, logPath, approvalSocketPath }) {
  const logFd = openRotatingLog(logPath);
  try {
    const child = spawn("codex", args, {
      cwd,
      detached: true,
      env: { ...process.env, WAGA_APPROVAL_SOCKET: approvalSocketPath },
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    return child.pid;
  } finally {
    fs.closeSync(logFd);
  }
}

export async function ensureManagedCodexService({
  cwd = process.cwd(),
  configPath = path.join(os.homedir(), ".codex", "config.toml"),
  paths = managedCodexPaths(),
  probe = probeSocket,
  startServer = spawnBackgroundServer,
} = {}) {
  fs.mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
  if (await probe(paths.socketPath)) return { started: false, ...paths };

  const previousPid = readPid(paths.pidPath);
  if (previousPid && processExists(previousPid)) {
    throw new Error(`Codex background service process ${previousPid} exists but its socket is unavailable`);
  }
  if (fs.existsSync(paths.socketPath) && !previousPid) {
    throw new Error(`Refusing to replace an unowned socket: ${paths.socketPath}`);
  }
  if (previousPid) {
    if (fs.existsSync(paths.socketPath)) fs.unlinkSync(paths.socketPath);
    fs.unlinkSync(paths.pidPath);
  }

  const names = fs.existsSync(configPath)
    ? configuredMcpServerNames(fs.readFileSync(configPath, "utf8"))
    : [];
  const args = managedAppServerArgs(paths.socketPath, { mcpServerNames: names });
  const pid = startServer(args, {
    cwd,
    logPath: paths.logPath,
    approvalSocketPath: paths.approvalSocketPath,
  });
  if (!Number.isInteger(pid) || pid <= 1) throw new Error("Codex background service did not return a valid pid");
  fs.writeFileSync(paths.pidPath, `${pid}\n`, { mode: 0o600 });

  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await probe(paths.socketPath)) return { started: true, pid, ...paths };
    if (!processExists(pid)) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Codex background service failed to open ${paths.socketPath}; see ${paths.logPath}`);
}

export async function stopManagedCodexService({
  paths = managedCodexPaths(),
  probe = probeSocket,
  processAlive = processExists,
  readCommandLine = readProcessCommandLine,
  signalProcess = process.kill.bind(process),
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const pid = readPid(paths.pidPath);
  if (!pid) {
    if (await probe(paths.socketPath)) {
      throw new Error("Refusing to stop a reachable Codex background socket without a recorded pid");
    }
    return { stopped: false, pid: null };
  }

  if (!processAlive(pid)) {
    if (await probe(paths.socketPath)) {
      throw new Error(`Codex background socket is reachable but recorded process ${pid} is gone`);
    }
    removeRuntimeEndpoint(paths);
    return { stopped: false, pid };
  }

  let commandLine;
  try {
    commandLine = readCommandLine(pid);
  } catch (error) {
    if (!processAlive(pid) && !(await probe(paths.socketPath))) {
      removeRuntimeEndpoint(paths);
      return { stopped: false, pid };
    }
    throw error;
  }
  if (!isManagedAppServerCommand(commandLine, paths.socketPath)) {
    throw new Error(`Refusing to stop unverified process ${pid}`);
  }

  signalProcess(pid, "SIGTERM");
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!processAlive(pid) && !(await probe(paths.socketPath))) {
      removeRuntimeEndpoint(paths);
      return { stopped: true, pid };
    }
    await wait(50);
  }

  throw new Error(`Codex background service ${pid} did not stop after SIGTERM`);
}
