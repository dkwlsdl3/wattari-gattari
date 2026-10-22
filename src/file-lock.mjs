import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function publishOwner(file) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, String(process.pid), { flag: 'wx', mode: 0o600 });
    fs.linkSync(temporary, file); // Publish the complete owner without replacing a lock.
  } finally { fs.rmSync(temporary, { force: true }); }
}
function ownerAlive(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let pid;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.size > 32) throw Error(`저장 잠금의 소유 정보를 확인할 수 없습니다: ${file}`);
    pid = Number(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}

// Synchronous stores must lock the entire read/modify/rename, across Node processes.
export function withFileLock(file, update) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`, recovery = `${lock}.recover`, deadline = Date.now() + 5000;
  for (;;) {
    try { publishOwner(lock); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    try {
      if (!ownerAlive(lock)) {
        let recovering = false;
        try { publishOwner(recovery); recovering = true; }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        if (recovering) {
          try { if (!ownerAlive(lock)) fs.unlinkSync(lock); }
          finally { fs.unlinkSync(recovery); }
          continue;
        }
      }
    } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (Date.now() >= deadline) throw Object.assign(Error(`저장 잠금이 사용 중이거나 복구 확인이 필요합니다: ${lock}`), { code: 'FILE_LOCK_BUSY' });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  try { return update(); } finally { fs.unlinkSync(lock); }
}
