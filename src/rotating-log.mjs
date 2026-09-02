import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_BACKUPS = 3;

export function openRotatingLog(filePath, {
  maxBytes = DEFAULT_MAX_BYTES,
  backups = DEFAULT_BACKUPS,
} = {}) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) {
    throw new TypeError("Log path must be absolute");
  }
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new TypeError("maxBytes must be a positive integer");
  if (!Number.isInteger(backups) || backups < 0) throw new TypeError("backups must be a non-negative integer");
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(filePath) && fs.statSync(filePath).size >= maxBytes) {
    if (backups === 0) {
      fs.unlinkSync(filePath);
    } else {
      const oldest = `${filePath}.${backups}`;
      if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
      for (let index = backups - 1; index >= 1; index -= 1) {
        const source = `${filePath}.${index}`;
        if (fs.existsSync(source)) fs.renameSync(source, `${filePath}.${index + 1}`);
      }
      fs.renameSync(filePath, `${filePath}.1`);
    }
  }
  return fs.openSync(filePath, "a", 0o600);
}
