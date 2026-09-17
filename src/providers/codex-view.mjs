const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The 29-character cut lands inside the last group, so a truncated title still
// proves the shape of a thread id even when that thread is unknown to Waga.
const TRUNCATED_THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{5}\.\.\.$/i;

// Codex 0.153.2 emits thread-id titles as 29 characters + "...".
// This is a UI reuse hint, never a message-routing or authorization identity.
export function retainedCodexViewState(nativeId, title, frame, knownNativeIds = []) {
  if (typeof nativeId !== "string" || !THREAD_ID.test(nativeId)) return "unknown";
  if (typeof frame !== "string" || frame.length === 0) return "unknown";
  const firstLine = String(frame).trimStart().split("\n", 1)[0].trim();
  // /agents retains the previous thread's title (and PID) in this version.
  if (firstLine === "Agent command center") return "different";
  const marker = String(title).trim();
  if (THREAD_ID.test(marker)) return marker === nativeId ? "same" : "different";
  // Missing and startup titles do not prove navigation. Killing the frontend
  // here would restart an in-progress resume.
  if (!TRUNCATED_THREAD_ID.test(marker)) return "unknown";
  // A foreign thread id is navigation whether or not discovery has seen it.
  if (marker !== `${nativeId.slice(0, 29)}...`) return "different";
  // Another known thread sharing our prefix makes the truncated title ambiguous.
  const ambiguous = knownNativeIds.some((id) =>
    typeof id === "string" && THREAD_ID.test(id) && id !== nativeId && `${id.slice(0, 29)}...` === marker);
  return ambiguous ? "unknown" : "same";
}
