import { spawn } from "node:child_process";

import { EventLog } from "./event-log.mjs";

const LEAVE_OVERVIEW = "\x1b[?25h\x1b[?1049l";
const ENTER_OVERVIEW = "\x1b[?1049h\x1b[?25l\x1b[2J";

function defaultLaunch(command, args, { cwd, env, inputStream, outputStream, errorOutput }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: [inputStream, outputStream, errorOutput],
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal }));
  });
}

export class DirectWorkspace {
  #inputStream;
  #outputStream;
  #errorOutput;
  #env;
  #launch;
  #eventLog;

  constructor({
    inputStream = process.stdin,
    outputStream = process.stdout,
    errorOutput = process.stderr,
    env = process.env,
    launch = defaultLaunch,
    eventLog = new EventLog(),
  } = {}) {
    this.#inputStream = inputStream;
    this.#outputStream = outputStream;
    this.#errorOutput = errorOutput;
    this.#env = env;
    this.#launch = launch;
    this.#eventLog = eventLog;
  }

  async focusOrOpen(session, commandSpec) {
    if (this.#inputStream.isTTY) this.#inputStream.setRawMode(false);
    this.#inputStream.pause?.();
    this.#outputStream.write(LEAVE_OVERVIEW);
    const context = { provider: session.provider, sessionId: session.id, command: commandSpec.command };
    this.#eventLog.record("native_session_started", context);
    try {
      const result = await this.#launch(commandSpec.command, commandSpec.args, {
        cwd: commandSpec.cwd,
        env: this.#env,
        inputStream: this.#inputStream,
        outputStream: this.#outputStream,
        errorOutput: this.#errorOutput,
      });
      this.#eventLog.record("native_session_exited", { ...context, code: result.code, signal: result.signal ?? null });
      return { reused: false, ...result };
    } catch (error) {
      this.#eventLog.record("native_session_launch_failed", { ...context, code: error.code ?? null, message: error.message });
      throw error;
    } finally {
      this.#outputStream.write(ENTER_OVERVIEW);
      if (this.#inputStream.isTTY) this.#inputStream.setRawMode(true);
      this.#inputStream.resume?.();
    }
  }

  async closeSessionView() {
    return { closed: false };
  }

  async reconcileSessionViews() {
    return { closed: [] };
  }

  async shouldRefreshOverview() {
    return true;
  }

  async leave() {
    return { closeOverview: true };
  }
}
