export function stopDialogDecision(key) {
  return key?.ctrl === true && key.name === "x" ? "confirm" : "cancel";
}

export function shutdownDialogDecision(key) {
  return key?.ctrl === true && key.name === "q" ? "confirm" : "cancel";
}
