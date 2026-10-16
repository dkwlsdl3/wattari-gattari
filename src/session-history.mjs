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
  return text ? { id: row.uuid || String(offset), role: row.type === "user" ? "user" : "assistant", text,
    ...(typeof row.timestamp === "string" && Number.isFinite(Date.parse(row.timestamp)) ? { timestamp: row.timestamp } : {}) } : null;
}

const bounded = value => {
  const text = historyText(value);
  return text.length > 12_000 ? `${text.slice(0, 12_000)}\n… (내용 일부)` : text;
};
export function claudeConversationRecord(row, session, offset) {
  if (row?.sessionId !== session.sessionId || row.isSidechain || row.isMeta) return null;
  const blocks = Array.isArray(row.message?.content) ? row.message.content : [];
  const message = claudeHistoryMessage(row, session, offset);
  const activities = blocks.flatMap(block => {
    if (row.type === "assistant" && block.type === "tool_use" && block.id) {
      const input = block.input ?? {};
      return [{ id: `tool:${block.id}`, role: "activity", tool: block.name,
        ...(typeof row.timestamp === "string" && Number.isFinite(Date.parse(row.timestamp)) ? { timestamp: row.timestamp } : {}),
        text: bounded(input.description || input.command || input.file_path || input.query || block.name), state: "running" }];
    }
    if (row.type === "user" && block.type === "tool_result" && block.tool_use_id) {
      return [{ id: `tool:${block.tool_use_id}`, role: "activity", output: bounded(block.content), state: block.is_error ? "error" : "completed" }];
    }
    return [];
  });
  return [...(message ? [message] : []), ...activities];
}

export function codexConversationItem(entry, fallbackId, activities = false) {
  const item = entry.item;
  if (!item) return null;
  const common = { id: item.id ?? entry.id ?? fallbackId, turnId: entry.turnId,
    ...(Number.isFinite(entry.startedAtMs) ? { timestamp: entry.startedAtMs } : {}) };
  if (["userMessage", "agentMessage"].includes(item.type)) {
    const text = historyText(item.type === "userMessage" ? item.content : item.text);
    return text ? { ...common, role: item.type === "userMessage" ? "user" : "assistant", text } : null;
  }
  if (!activities) return null;
  const labels = { commandExecution: "명령 실행", fileChange: "파일 변경", mcpToolCall: "도구 호출", webSearch: "웹 검색", collabAgentToolCall: "에이전트 호출" };
  if (!labels[item.type]) return null;
  const state = ["failed", "declined"].includes(item.status) || (Number.isInteger(item.exitCode) && item.exitCode !== 0)
    ? "error" : item.status === "completed" || entry.completedAtMs != null ? "completed" : "running";
  return { ...common, role: "activity", tool: labels[item.type], state,
    text: bounded(item.command || item.tool || item.query || item.changes?.map(change => change.path).join("\n") || labels[item.type]),
    output: bounded(item.aggregatedOutput ?? "") };
}

// A result updates its original tool row, preserving position and the call's label.
export function mergeHistoryMessages(...pages) {
  const rows = new Map();
  for (const page of pages) for (const row of page) rows.set(row.id, { ...rows.get(row.id), ...row });
  return [...rows.values()];
}
