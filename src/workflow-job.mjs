// A disposable worker owns its process and result even if the coordinating CLI exits.
import fs from 'node:fs/promises';
import path from 'node:path';
import { acquireLock } from './workflow-recovery.mjs';
import { guardedProcess } from './workflow-runtime.mjs';
import { sampleResources, hasCapacity } from './resource-gate.mjs';
const file = process.argv[2];
const job = JSON.parse(await fs.readFile(file, 'utf8'));
const write = async (suffix, value) => { const tmp = `${file}.${suffix}.${process.pid}.tmp`; await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600 }); await fs.rename(tmp, `${file}.${suffix}`); };
await write('owner', { pid: process.pid, startedAt: Date.now() });
let slot, slotFile;
const stopped = async () => { try { await fs.access(`${file}.stop`); throw Error('실행 중단 요청'); } catch (error) { if (error.code !== 'ENOENT') throw error; } };
try {
  await fs.mkdir(job.poolDirectory, { recursive: true, mode: 0o700 });
  while (!slot) {
    await stopped();
    if (Date.now() - job.preparedAt > job.timeoutMs) throw Error('작업 대기 시간 한도');
    for (let i = 0; i < 2; i++) { try { slotFile = path.join(job.poolDirectory, String(i)); slot = await acquireLock(slotFile); break; } catch (error) { if (!['EBUSY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error; } }
    if (!slot) await new Promise(resolve => setTimeout(resolve, 250));
  }
  while (!hasCapacity(sampleResources(), { reserveGiB: job.reserveGiB, maxCpuPercent: job.maxCpuPercent ?? 80 })) { await stopped(); if (Date.now() - job.preparedAt > job.timeoutMs) throw Error('자원 대기 시간 한도'); await new Promise(resolve => setTimeout(resolve, 250)); }
  const result = await guardedProcess(job.argv, { cwd: job.cwd, env: job.env, timeoutMs: Math.max(1, job.timeoutMs - (Date.now() - job.preparedAt)), monitor: async () => {
    const resource = sampleResources();
    if (resource.availableGiB < Math.max(4.5, job.reserveGiB - 1)) throw Error('여유 메모리 하한 도달');
    await stopped();
  } });
  await write('result', result);
} catch (error) { await write('result', { exitCode: null, stdout: '', stderr: '', signal: null, failure: error.message }); }
finally { if (slot) { await slot.close(); await fs.rm(slotFile, { force: true }); } }
