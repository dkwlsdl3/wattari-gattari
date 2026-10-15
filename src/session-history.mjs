import { stripVTControlCharacters } from "node:util";

// Native structured text only; tool results and reasoning stay outside the conversation.
export function historyText(content) {
  const value = typeof content === "string" ? content : Array.isArray(content)
    ? content.filter(block => block?.type === "text" && typeof block.text === "string").map(block => block.text).join("\n") : "";
  return stripVTControlCharacters(value).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

export function claudeHistoryMessage(row, session, offset) {
  if (row?.sessionId !== session.sessionId || row.isSidechain || row.isMeta) return null;
  if (row.type !== "assistant" && row.type !== "user") return null;
  if (row.type === "user" && (row.toolUseResult || (row.origin && row.origin.kind !== "human")
    || row.message?.content?.some?.(block => block.type === "tool_result"))) return null;
  const text = historyText(row.message?.content);
  return text ? { id: row.uuid || String(offset), role: row.type === "user" ? "user" : "assistant", text } : null;
}
