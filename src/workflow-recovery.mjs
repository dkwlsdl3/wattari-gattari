import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function readJson(file) { try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
export function alive(pid) { if (!Number.isInteger(pid) || pid < 1) return true; try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } }
export async function acquireLock(file) {
  try { const handle = await fs.open(file, 'wx', 0o600); await handle.writeFile(String(process.pid)); return handle; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const guard = await fs.open(`${file}.recover`, 'wx', 0o600).catch(error => { if (error.code === 'EEXIST') throw Object.assign(Error('다른 실행기가 잠금을 복구 중입니다.'), { code: 'EBUSY' }); throw error; });
    try {
      const owner = Number(await fs.readFile(file, 'utf8'));
      if (alive(owner)) throw Object.assign(Error('실행 잠금의 소유 프로세스가 살아 있거나 확인되지 않습니다.'), { code: 'EBUSY' });
      await fs.unlink(file);
      const handle = await fs.open(file, 'wx', 0o600); await handle.writeFile(String(process.pid)); return handle;
    } finally { await guard.close(); await fs.rm(`${file}.recover`, { force: true }); }
  }
}
export async function durableProcess(file, argv, { cwd, env = {}, reserveGiB = 6, maxCpuPercent = 80, poolDirectory = path.join(path.dirname(file), "slots"), monitor = async () => {}, intervalMs = 1000, timeoutMs = 180000 } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  let job = await readJson(file);
  if (!job) {
    job = { argv, cwd, env, reserveGiB, maxCpuPercent, poolDirectory, timeoutMs, preparedAt: Date.now() };
    await fs.writeFile(file, JSON.stringify(job), { mode: 0o600, flag: 'wx' });
    const child = spawn(process.execPath, [new URL('./workflow-job.mjs', import.meta.url).pathname, file], { detached: true, stdio: 'ignore' }); child.unref();
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  } else if (job.cwd !== cwd || JSON.stringify(job.argv) !== JSON.stringify(argv)) throw Error('저장된 실행 요청과 재개 요청이 다릅니다. 자동 재전송하지 않습니다.');
  for (;;) {
    const result = await readJson(`${file}.result`); if (result) return result;
    const owner = await readJson(`${file}.owner`);
    if ((owner && !alive(owner.pid)) || (!owner && Date.now() - job.preparedAt > 10000) || Date.now() - job.preparedAt > job.timeoutMs + 15000) throw Object.assign(Error('실행 결과가 불확실합니다. 저장된 요청을 회수해야 합니다. 자동 재전송하지 않습니다.'), { kind: 'uncertain' });
    try { await monitor(); } catch (error) { await fs.writeFile(`${file}.stop`, '', { mode: 0o600 }); throw error; }
    await sleep(intervalMs);
  }
}
