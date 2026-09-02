import crypto from "node:crypto";
import net from "node:net";

import { defaultSocketPath } from "./broker.mjs";
import { readJsonLines, writeJsonLine } from "./line-json.mjs";

export async function request(method, params = {}, { socketPath = defaultSocketPath() } = {}) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.connect(socketPath);
    socket.once("connect", () => writeJsonLine(socket, { id, method, params }));
    socket.once("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    socket.once("close", () => {
      if (settled) return;
      settled = true;
      reject(new Error("Broker connection closed before a response arrived"));
    });
    readJsonLines(socket, (response) => {
      if (settled || response.id !== id) return;
      settled = true;
      socket.end();
      if (response.ok) resolve(response.result);
      else {
        const error = new Error(response.error?.message ?? "Broker request failed");
        error.code = response.error?.code;
        reject(error);
      }
    });
  });
}
