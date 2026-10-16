const COMMANDS = new Set(["plan", "run", "serve", "list", "agents", "send", "ask", "result", "open", "overview", "tmux-agents-view", "doctor", "help"]);
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_REPLY_TIMEOUT_MS = 3 * 60 * 1_000;

function invalid(message) {
  return Object.assign(new Error(message), { code: "INVALID_ARGUMENT" });
}

export function parseCliArgs(args) {
  const options = {
    command: "default",
    cwd: null,
    provider: null,
    backend: "auto",
    waitTimeoutMs: DEFAULT_WAIT_TIMEOUT_MS,
    replyTimeoutMs: DEFAULT_REPLY_TIMEOUT_MS,
    untilIdle: false,
    notifyOrigin: false,
    json: false,
  };
  const positional = [];
  let commandSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") { options.command = "help"; commandSeen = true; continue; }
    if (arg === "--version" || arg === "-v") { options.command = "version"; commandSeen = true; continue; }
    if (arg === "--json") { options.json = true; continue; }
    if (arg === '--execute') { options.execute = true; continue; }
    if (arg === "--until-idle") { options.untilIdle = true; continue; }
    if (arg === "--notify-origin") { options.notifyOrigin = true; continue; }
    if (["--resume", "--port", "--cwd", "--provider", "--backend", "--timeout", "--wait-timeout", "--reply-timeout"].includes(arg)) {
      const value = args[++index];
      if (!value) throw invalid(`${arg} requires a value`);
      if (arg === "--resume") options.resume = value;
      if (arg === "--cwd") options.cwd = value;
      if (arg === "--provider") options.provider = value;
      if (arg === "--backend") options.backend = value;
      if (arg === "--port") {
        if (!/^\d+$/.test(value) || Number(value) > 65535) throw invalid("--port must be between 0 and 65535");
        options.port = Number(value);
      }
      if (["--timeout", "--wait-timeout", "--reply-timeout"].includes(arg)) {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds <= 0) throw invalid(`${arg} must be a positive number of seconds`);
        const milliseconds = Math.ceil(seconds * 1_000);
        if (!Number.isSafeInteger(milliseconds)) throw invalid(`${arg} is too large`);
        if (arg === "--timeout" || arg === "--wait-timeout") options.waitTimeoutMs = milliseconds;
        if (arg === "--timeout" || arg === "--reply-timeout") options.replyTimeoutMs = milliseconds;
      }
      continue;
    }
    if (arg.startsWith("-")) throw invalid(`Unknown option: ${arg}`);
    if (!commandSeen && COMMANDS.has(arg)) {
      options.command = arg === "agents" ? "list" : arg;
      commandSeen = true;
    } else positional.push(arg);
  }

  if (options.command === "default" && (options.json || options.provider)) options.command = "list";
  if (options.command === "serve") options.port ??= 4317;
  if (args.includes("--port") && options.command !== "serve") throw invalid("--port is only valid for serve");
  if (options.provider && !["claude", "codex"].includes(options.provider)) throw invalid(`Unknown provider: ${options.provider}`);
  if (!["auto", "direct", "tmux"].includes(options.backend)) throw invalid(`Unknown backend: ${options.backend}`);
  if (options.backend !== "auto" && options.command !== "default") throw invalid("--backend is only valid for the interactive dock");
  if (options.untilIdle && options.command !== "ask") throw invalid("--until-idle is only valid for ask");
  if (options.notifyOrigin && options.command !== "ask") throw invalid("--notify-origin is only valid for ask");
  if (options.resume && options.command !== "run") throw invalid("--resume is only valid for run");
  if (options.execute && options.command !== 'plan') throw invalid('--execute is only valid for plan');
  if (options.command === 'plan') {
    options.target = positional.shift(); options.manifest = positional.shift();
    if (!/^(claude|codex):.+$/.test(options.target ?? '') || positional.length) throw invalid('plan requires a full provider-prefixed session ID and an optional plan JSON file');
    if (options.execute && !options.manifest) throw invalid('--execute requires a plan JSON file');
  } else if (options.command === "run") {
    options.manifest = positional.shift();
    if (!options.manifest || positional.length) throw invalid("run requires one workflow JSON file");
    if (options.resume && !/^[0-9a-f-]{36}$/.test(options.resume)) throw invalid("--resume requires a run ID");
  } else if (["send", "ask"].includes(options.command)) {
    options.target = positional.shift();
    options.message = positional.join(" ").trim();
    if (!options.target || !options.message) throw invalid(`${options.command} requires a target and message`);
  } else if (options.command === "result") {
    options.requestId = positional.shift();
    if (!options.requestId || positional.length) throw invalid("result requires one request ID");
  } else if (options.command === "open") {
    options.provider = positional.shift() ?? options.provider;
    if (!options.provider) throw invalid("open requires claude or codex");
    if (!['claude', 'codex'].includes(options.provider)) throw invalid(`Unknown provider: ${options.provider}`);
    if (positional.length) throw invalid(`Unexpected argument: ${positional[0]}`);
  } else if (options.command === "tmux-agents-view") {
    options.windowId = positional.shift();
    if (!/^@[0-9]+$/.test(options.windowId ?? "") || positional.length) throw invalid("tmux-agents-view requires one tmux window id");
  } else if (positional.length) throw invalid(`Unexpected argument: ${positional[0]}`);
  return options;
}
