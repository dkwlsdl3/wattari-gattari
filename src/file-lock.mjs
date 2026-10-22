import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Synchronous stores must lock the entire read/modify/rename, across Node processes.
export function withFileLock(file, update) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const fd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid()) throw Error(`저장 잠금의 소유 정보를 확인할 수 없습니다: ${lock}`);
    // flock locks the shared open-file description. Our fd keeps it locked after
    // the command exits; close or process termination releases it automatically.
    const result = spawnSync('flock', ['--exclusive', '--timeout', '5', '3'], {
      stdio: ['ignore', 'pipe', 'pipe', fd], encoding: 'utf8', timeout: 6000,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Object.assign(Error(`저장 잠금을 얻지 못했습니다: ${result.stderr.trim() || lock}`), {
      code: result.status === 1 ? 'FILE_LOCK_BUSY' : 'FILE_LOCK_FAILED',
    });
    return update();
  } finally {
    // Keep the file: unlinking would let later writers lock a different inode.
    fs.closeSync(fd);
  }
}
