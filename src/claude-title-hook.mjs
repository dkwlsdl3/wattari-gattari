#!/usr/bin/env node
import { ClaudeTitleSync } from "./claude-title-sync.mjs";

// Keep hook failures out of the model context and never block the user's turn.
try {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error("Hook input too large");
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const output = new ClaudeTitleSync(process.argv[2]).hook(input);
  if (output) process.stdout.write(JSON.stringify(output));
} catch {
  process.stderr.write("Waga title sync skipped; retry F2 if needed.\n");
}
