// This is a display-only prefix from buildPeerEnvelope, not a transcript parser.
const replyPrefix = /^\[WAGA REPLY ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\]\s*/i;
export function readableReply(value = "") {
  return value.replace(replyPrefix, "").trim();
}

export function conversationItems({ preview, records = [], inputs = new Map(), pending } = {}) {
  const exchanges = new Map();
  for (const record of [...records].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))) {
    if (record.state === "created") continue;
    const key = record.requestId ?? record.operationId;
    const previous = exchanges.get(key);
    exchanges.set(key, { ...previous, ...record, reply: record.reply ?? previous?.reply,
      input: inputs.get(record.operationId) ?? previous?.input, at: previous?.at ?? record.at });
  }
  if (pending?.kind === "query" && !records.some(row => row.operationId === pending.operationId)) {
    exchanges.set(pending.operationId, { operationId: pending.operationId, input: inputs.get(pending.operationId) });
  }
  const items = [];
  const tracked = [...exchanges.values()];
  const output = readableReply(preview?.output);
  const previewId = preview?.output?.match(replyPrefix)?.[1];
  const duplicated = tracked.some(row => {
    if (row.reply === undefined) return false;
    const reply = readableReply(row.reply);
    return (previewId && row.requestId === previewId) || (output && output === reply)
      || (output.length >= 80 && ((preview?.limited && reply.startsWith(output)) || (row.replyLimited && output.startsWith(reply))));
  });
  if (!tracked.length && preview?.input) items.push({ role: "user", text: preview.input, label: "최근 입력" });
  for (const record of tracked) {
    if (record.input) items.push({ role: "user", text: record.input, label: "보낸 메시지" });
    if (record.reply !== undefined) items.push({ role: "assistant", text: readableReply(record.reply), label: "답변", limited: record.replyLimited });
  }
  if (output && !duplicated) items.push({ role: "assistant", text: output, label: tracked.length ? "세션의 최근 응답" : "최근 응답", limited: preview?.limited });
  return items;
}
