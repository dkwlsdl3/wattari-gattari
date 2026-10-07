import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

function replyFile(session, homeDirectory) {
  if (!/^[0-9a-f-]{36}$/i.test(session.sessionId) || !path.isAbsolute(session.cwd ?? "")) return null;
  return path.join(homeDirectory, ".claude", "projects", session.cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${session.sessionId}.jsonl`);
}

// Snapshot before submission: live recovery scans only bytes appended for this request.
export async function claudeReplyOffset(session, homeDirectory) {
  const file = replyFile(session, homeDirectory);
  if (!file) return null;
  try { return (await fs.promises.stat(file)).size; }
  catch (error) { return error.code === "ENOENT" ? 0 : null; }
}

export async function waitForClaudeReply(session, requestId, { socketReply, signal, ...options }) {
  if (options.start === null) return socketReply;
  const cleanup = new AbortController();
  const pollSignal = AbortSignal.any([signal, cleanup.signal]);
  const transcriptReply = async () => {
    while (true) {
      // A tool call record precedes delivery; do not close its destination early.
      const text = await readClaudeReply(session, requestId, { ...options, includeToolReplies: false, signal: pollSignal });
      if (text) return { text };
      await delay(250, undefined, { signal: pollSignal });
    }
  };
  try {
    // An inaccessible native log must not disable the primary socket reply path.
    return await Promise.race([socketReply, transcriptReply().catch(error => {
      if (pollSignal.aborted) throw error;
      return socketReply;
    })]);
  } finally { cleanup.abort(); }
}

// The native JSONL assistant text / SendMessage shapes were observed in Keeper
// on 2026-09-10. Only an explicit request tag from the exact session is accepted.
export async function readClaudeReply(session, requestId, { homeDirectory, since, fromSocket, start = 0, signal, includeToolReplies = true } = {}) {
  const file = replyFile(session, homeDirectory);
  if (!file) return null;
  const marker = `[WAGA REPLY ${requestId}]`;
  let buffer = "", dropping = false;
  const stream = fs.createReadStream(file, { encoding: "utf8", highWaterMark: 64 * 1024, start, signal });
  try {
    for await (const chunk of stream) {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (dropping) { dropping = false; continue; }
        if (line.length > 4 * 1024 * 1024) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (row.type !== "assistant" || row.sessionId !== session.sessionId || row.isSidechain || row.isMeta || !(Date.parse(row.timestamp) >= since)) continue;
        for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
          let text = block.type === "text" ? block.text : null;
          if (includeToolReplies && block.type === "tool_use" && block.name === "SendMessage" && fromSocket && block.input?.to === `uds:${fromSocket}`) text = block.input.message;
          if (typeof text === "string" && text.startsWith(marker) && text.slice(marker.length).trim()) return text;
        }
      }
      if (buffer.length > 4 * 1024 * 1024) { buffer = ""; dropping = true; }
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  finally { stream.destroy(); }
  return null;
}
