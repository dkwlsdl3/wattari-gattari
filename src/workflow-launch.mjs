import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { APP_ID } from './product.mjs';
import { alive, readJson } from './workflow-recovery.mjs';
export const runtimeRoot = () => path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), APP_ID, 'runtime');
export async function launchWorkflow(run, secret, origin, root = runtimeRoot()) {
  const directory = path.join(root, run.id);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o077)) throw Error('실행 경로는 비공개여야 합니다.');
  const launcher = await readJson(path.join(directory, 'launcher.json'));
  if (launcher && alive(launcher.pid)) throw Object.assign(Error('해당 실행기가 이미 작동 중입니다.'), { status: 409 });
  const manifest = path.join(directory, 'workflow.json');
  try { await fs.writeFile(path.join(directory, 'client.json'), JSON.stringify({ origin, secret }), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await fs.writeFile(manifest, JSON.stringify(run.definition), { mode: 0o600 });
  const log = await fs.open(path.join(directory, 'runner.log'), 'a', 0o600);
  try {
    const child = spawn(process.execPath, [new URL('./workflow-worker.mjs', import.meta.url).pathname, manifest, run.id, root], { detached: true, stdio: ['ignore', log.fd, log.fd] });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
    await fs.writeFile(path.join(directory, 'launcher.json'), JSON.stringify({ pid: child.pid, startedAt: Date.now() }), { mode: 0o600 });
    return { runId: run.id };
  } finally { await log.close(); }
}

export async function workflowRunning(id, root = runtimeRoot()) { const record = await readJson(path.join(root, id, 'launcher.json')); return Boolean(record && alive(record.pid)); }
