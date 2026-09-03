const COMMANDS = new Set(["list", "agents", "send", "ask", "open", "overview", "doctor", "help"]);

function invalid(message) {
  return Object.assign(new Error(message), { code: "INVALID_ARGUMENT" });
}

export function parseCliArgs(args) {
  const options = { command: "default", cwd: null, provider: null, backend: "auto", timeoutMs: 180_000, json: false };
  const positional = [];
  let commandSeen = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") { options.command = "help"; commandSeen = true; continue; }
    if (arg === "--version" || arg === "-v") { options.command = "version"; commandSeen = true; continue; }
    if (arg === "--json") { options.json = true; continue; }
    if (["--cwd", "--provider", "--backend", "--timeout"].includes(arg)) {
      const value = args[++index];
      if (!value) throw invalid(`${arg} requires a value`);
      if (arg === "--cwd") options.cwd = value;
      if (arg === "--provider") options.provider = value;
      if (arg === "--backend") options.backend = value;
      if (arg === "--timeout") {
        const seconds = Number(value);
        if (!Number.isFinite(seconds) || seconds <= 0) throw invalid("--timeout must be a positive number of seconds");
        options.timeoutMs = Math.ceil(seconds * 1_000);
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
  if (options.provider && !["claude", "codex"].includes(options.provider)) throw invalid(`Unknown provider: ${options.provider}`);
  if (!["auto", "direct", "tmux"].includes(options.backend)) throw invalid(`Unknown backend: ${options.backend}`);
  if (options.backend !== "auto" && options.command !== "default") throw invalid("--backend is only valid for the interactive dock");
  if (["send", "ask"].includes(options.command)) {
    options.target = positional.shift();
    options.message = positional.join(" ").trim();
    if (!options.target || !options.message) throw invalid(`${options.command} requires a target and message`);
  } else if (options.command === "open") {
    options.provider = positional.shift() ?? options.provider;
    if (!options.provider) throw invalid("open requires claude or codex");
    if (!['claude', 'codex'].includes(options.provider)) throw invalid(`Unknown provider: ${options.provider}`);
  } else if (positional.length) throw invalid(`Unexpected argument: ${positional[0]}`);
  return options;
}
