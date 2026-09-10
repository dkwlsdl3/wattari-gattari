import fs from "node:fs";
import path from "node:path";

// The native JSONL assistant text / SendMessage shapes were observed in Keeper
// on 2026-09-10. Only an explicit request tag from the exact session is accepted.
export async function readClaudeReply(session, requestId, { homeDirectory, since, fromSocket } = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(session.sessionId) || !path.isAbsolute(session.cwd)) return null;
  const file = path.join(homeDirectory, ".claude", "projects", session.cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${session.sessionId}.jsonl`);
  const marker = `[WAGA REPLY ${requestId}]`;
  let buffer = "", dropping = false;
  const stream = fs.createReadStream(file, { encoding: "utf8", highWaterMark: 64 * 1024 });
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
          if (block.type === "tool_use" && block.name === "SendMessage" && fromSocket && block.input?.to === `uds:${fromSocket}`) text = block.input.message;
          if (typeof text === "string" && text.startsWith(marker) && text.slice(marker.length).trim()) return text;
        }
      }
      if (buffer.length > 4 * 1024 * 1024) { buffer = ""; dropping = true; }
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  finally { stream.destroy(); }
  return null;
}
