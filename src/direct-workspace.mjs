import { spawn } from "node:child_process";
import { constants } from 'node:os';

import { EventLog } from "./event-log.mjs";
import { retainedCodexViewState } from './providers/codex-view.mjs';

const LEAVE_OVERVIEW = "\x1b[?25h\x1b[?1049l";
const ENTER_OVERVIEW = "\x1b[?1049h\x1b[?25l\x1b[2J";

async function launchWithAttach(command, args, { cwd, env, inputStream, outputStream, nativeId, afterAttach }) {
  const [{ default: pty }, { default: xterm }] = await Promise.all([import('node-pty'), import('@xterm/headless')]);
  const cols = outputStream.columns || 80, rows = outputStream.rows || 24;
  const screen = new xterm.Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  const replies = new xterm.Terminal({ scrollback: 0, allowProposedApi: true });
  let child, ready = false, exited = false, stopped = false, title = '', timer, output;
  // During attach, user keys are discarded. xterm decodes terminal reports
  // separately, preserving the real cursor position, palette and capabilities.
  const input = data => { if (ready) child.write(data.toString()); else replies.write(data.toString()); };
  const resize = () => {
    const width = outputStream.columns || 80, height = outputStream.rows || 24;
    child.resize(width, height); screen.resize(width, height);
  };
  try {
    child = pty.spawn(command, args, { cwd, env, name: env.TERM || 'xterm-256color', cols, rows });
    for (const osc of [4, 10, 11]) replies.parser.registerOscHandler(osc, body => {
      child.write(`\x1b]${osc};${body}\x07`); return true;
    });
    for (const id of [{ final: 'R' }, { prefix: '?', final: 'c' }, { prefix: '>', final: 'c' }, { prefix: '?', final: 'u' }, { prefix: '?', intermediates: '$', final: 'y' }]) {
      replies.parser.registerCsiHandler(id, params => {
        child.write(`\x1b[${id.prefix ?? ''}${params.join(';')}${id.intermediates ?? ''}${id.final}`); return true;
      });
    }
    screen.onTitleChange(value => { title = value; });
    const exit = new Promise(resolve => child.onExit(({ exitCode, signal }) => {
      exited = true;
      resolve({ code: exitCode, signal: signal ? Object.keys(constants.signals).find(key => constants.signals[key] === signal) : null });
    }));
    const attached = new Promise(resolve => {
      output = child.onData(data => {
        outputStream.write(data);
        if (ready) return;
        screen.write(data, () => {
          if (stopped) return;
          const buffer = screen.buffer.active;
          const frame = Array.from({ length: buffer.length }, (_, i) => buffer.getLine(i).translateToString(true)).join('\n');
          if (retainedCodexViewState(nativeId, title, frame) === 'same'
              && frame.includes('›') && !/Resuming session|Trust this folder\?/.test(frame)) resolve();
        });
      });
    });
    inputStream.setRawMode?.(true);
    inputStream.on('data', input); inputStream.resume();
    outputStream.on('resize', resize);
    await Promise.race([attached, exit.then(() => { throw Object.assign(Error('Codex frontend exited before attach completed'), { code: 'CODEX_ATTACH_FAILED' }); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error('Codex frontend did not finish attaching'), { code: 'CODEX_ATTACH_TIMEOUT' })), 30_000); })]);
    clearTimeout(timer);
    await afterAttach();
    if (exited) throw Object.assign(Error('Codex frontend exited during permission synchronization'), { code: 'CODEX_ATTACH_FAILED' });
    ready = true;
    return await exit;
  } finally {
    stopped = true;
    clearTimeout(timer);
    output?.dispose();
    inputStream.off('data', input); outputStream.off('resize', resize);
    if (child && !exited) child.kill();
    screen.dispose(); replies.dispose();
  }
}

function defaultLaunch(command, args, options) {
  if (options.afterAttach) return launchWithAttach(command, args, options);
  const { cwd, env, inputStream, outputStream, errorOutput } = options;
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
        ...(commandSpec.afterAttach ? { nativeId: session.nativeId, afterAttach: commandSpec.afterAttach } : {}),
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

  async openRemoteHost(host, commandSpec) {
    return this.focusOrOpen({ id: `host:${host.id}`, provider: "remote", name: host.name }, { ...commandSpec, cwd: process.cwd() });
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
