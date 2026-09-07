const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Codex 0.153.2 emits thread-id titles as 29 characters + "...".
// This is a UI reuse hint, never a message-routing or authorization identity.
export function retainedCodexViewMatches(nativeId, title, frame, knownNativeIds = []) {
  if (typeof nativeId !== "string" || !THREAD_ID.test(nativeId)) return false;
  const marker = String(title).trim();
  if (marker !== nativeId && marker !== `${nativeId.slice(0, 29)}...`) return false;
  if (marker !== nativeId && knownNativeIds.some((id) => id !== nativeId && typeof id === "string" && `${id.slice(0, 29)}...` === marker)) return false;
  if (typeof frame !== "string") return false;
  const firstLine = String(frame).trimStart().split("\n", 1)[0].trim();
  // /agents retains the previous thread's title (and PID) in this version.
  return Boolean(firstLine) && firstLine !== "Agent command center";
}
