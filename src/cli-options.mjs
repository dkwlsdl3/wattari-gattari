export function parseCliArgs(args) {
  const options = { command: "tui", cwd: null };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (["tui", "doctor", "stop", "help", "agents"].includes(arg) && index === 0) options.command = arg;
    else if (arg === "ask" && index === 0) {
      const target = args[index + 1];
      const task = args.slice(index + 2).join(" ").trim();
      if (!target || !task) throw Object.assign(new Error("ask requires a target and task"), { code: "INVALID_ARGUMENT" });
      options.command = "ask";
      options.target = target;
      options.task = task;
      break;
    }
    else if (arg === "--help" || arg === "-h") options.command = "help";
    else if (arg === "--version" || arg === "-v") options.command = "version";
    else if (arg === "--cwd") {
      const value = args[index + 1];
      if (!value) throw Object.assign(new Error("--cwd requires a path"), { code: "INVALID_ARGUMENT" });
      options.cwd = value;
      index += 1;
    } else {
      throw Object.assign(new Error(`Unknown argument: ${arg}`), { code: "INVALID_ARGUMENT" });
    }
  }
  return options;
}
