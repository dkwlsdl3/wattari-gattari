import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runCli } from "./cli.mjs";
import { serveWeb } from "./web-server.mjs";

export function serviceToken(file = path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local/state"), "wattari-gattari/web-token")) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  try { fs.writeFileSync(file, crypto.randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const token = fs.readFileSync(file, "utf8");
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error(`Invalid web service token: ${file}`);
  fs.chmodSync(file, 0o600);
  return token;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  const token = serviceToken();
  process.exitCode = await runCli(["serve", ...process.argv.slice(2)], {
    web: options => serveWeb({ ...options, token, showToken: false }),
  });
}
