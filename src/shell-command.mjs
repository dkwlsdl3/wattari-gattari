export function quote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

export function shellCommand(command, args = []) {
  return `exec ${[command, ...args].map(quote).join(' ')}`;
}
