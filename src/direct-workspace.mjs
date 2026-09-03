import { spawn } from "node:child_process";

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

  constructor({
    inputStream = process.stdin,
    outputStream = process.stdout,
    errorOutput = process.stderr,
    env = process.env,
    launch = defaultLaunch,
  } = {}) {
    this.#inputStream = inputStream;
    this.#outputStream = outputStream;
    this.#errorOutput = errorOutput;
    this.#env = env;
    this.#launch = launch;
  }

  async focusOrOpen(_session, commandSpec) {
    if (this.#inputStream.isTTY) this.#inputStream.setRawMode(false);
    this.#inputStream.pause?.();
    this.#outputStream.write(LEAVE_OVERVIEW);
    try {
      const result = await this.#launch(commandSpec.command, commandSpec.args, {
        cwd: commandSpec.cwd,
        env: this.#env,
        inputStream: this.#inputStream,
        outputStream: this.#outputStream,
        errorOutput: this.#errorOutput,
      });
      return { reused: false, ...result };
    } finally {
      this.#outputStream.write(ENTER_OVERVIEW);
      if (this.#inputStream.isTTY) this.#inputStream.setRawMode(true);
      this.#inputStream.resume?.();
    }
  }

  async closeSessionView() {
    return { closed: false };
  }

  async leave() {
    return { closeOverview: true };
  }
}
