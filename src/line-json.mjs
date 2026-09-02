const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

export function readJsonLines(socket, onMessage, { maxLineBytes = DEFAULT_MAX_LINE_BYTES } = {}) {
  let buffer = Buffer.alloc(0);

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > maxLineBytes && buffer.indexOf(0x0a) < 0) {
      socket.destroy(new Error(`JSON line exceeds ${maxLineBytes} bytes`));
      return;
    }

    let newline;
    while ((newline = buffer.indexOf(0x0a)) >= 0) {
      const raw = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (raw.length === 0) continue;
      if (raw.length > maxLineBytes) {
        socket.destroy(new Error(`JSON line exceeds ${maxLineBytes} bytes`));
        return;
      }
      try {
        onMessage(JSON.parse(raw.toString("utf8")));
      } catch (error) {
        socket.destroy(new Error(`Invalid JSON line: ${error.message}`));
        return;
      }
    }
  });
}

export function writeJsonLine(socket, value) {
  socket.write(`${JSON.stringify(value)}\n`);
}
