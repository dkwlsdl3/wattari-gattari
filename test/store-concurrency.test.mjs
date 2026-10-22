import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { once } from 'node:events';
import { DockOrderStore } from '../src/dock-order.mjs';

test('a killed store writer leaves a recoverable lock and no partial state', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waga-proof-store-killed-')), file = path.join(root, 'state.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const code = `import {withFileLock} from ${JSON.stringify(new URL('../src/file-lock.mjs', import.meta.url).href)};
withFileLock(${JSON.stringify(file)},()=>{process.send('locked');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,3000);});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exited = once(child, 'exit');
  t.after(async () => { child.kill('SIGKILL'); await exited; });
  await once(child, 'message'); child.kill('SIGKILL'); await exited;
  const store = new DockOrderStore(file);
  store.saveWorkspace('/work/recovered', ['codex:recovered']);
  assert.deepEqual([...store.load()], [['/work/recovered', ['codex:recovered']]]);
  assert.deepEqual(fs.readdirSync(root), ['state.json']);
});

test('a failed store update releases its lock so a corrected file can be saved', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waga-proof-store-failure-')), file = path.join(root, 'state.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(file, '{}');
  const store = new DockOrderStore(file);
  assert.throws(() => store.saveWorkspace('/work/retry', ['codex:proof']), { code: 'DOCK_ORDER_INVALID' });
  fs.unlinkSync(file); store.saveWorkspace('/work/retry', ['codex:proof']);
  assert.equal(store.load().size, 1);
  assert.deepEqual(fs.readdirSync(root), ['state.json']);
});

for (const [module, name, operation, initial, count] of [
  ['dock-order', 'DockOrderStore', i => `store.saveWorkspace('/work/${i}',['codex:${i}'])`, { version: 1, workspaces: [] }, value => value.workspaces.length],
  ['session-alias-catalog', 'SessionAliasCatalog', i => `store.set('claude:${i}','name-${i}')`, { version: 1, aliases: {} }, value => Object.keys(value.aliases).length],
]) {
  test(`${name} preserves distinct keys from two concurrent Node writers`, { timeout: 5000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waga-proof-store-race-')), file = path.join(root, 'state.json'), gate = path.join(root, 'release');
    fs.writeFileSync(file, JSON.stringify(initial));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const start = index => {
      const code = `import fs from 'node:fs';import {${name} as Store} from ${JSON.stringify(new URL(`../src/${module}.mjs`, import.meta.url).href)};
const read=fs.readFileSync;
if(${index}===1)fs.readFileSync=function(file,...args){const value=read.call(fs,file,...args);if(file===${JSON.stringify(file)}){process.send('snapshot');const end=Date.now()+3000;while(!fs.existsSync(${JSON.stringify(gate)})){if(Date.now()>end)throw Error('test barrier timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}}return value;};
const store=new Store(${JSON.stringify(file)});process.send('starting');${operation(index)};process.disconnect();`;
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      const messages = [], waiters = [];
      child.on('message', message => { messages.push(message); for (const resolve of waiters) resolve(); });
      let stderr = ''; child.stderr.on('data', value => { stderr += value; });
      const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve({ code, stderr })); });
      t.after(() => { child.kill(); });
      return { done, async waitFor(message) { while (!messages.includes(message)) await Promise.race([new Promise(resolve => waiters.push(resolve)), done.then(result => { throw Error(`writer exited: ${JSON.stringify(result)}`); })]); } };
    };
    const first = start(1); await first.waitFor('snapshot');
    const second = start(2); await second.waitFor('starting');
    await Promise.race([second.done, new Promise(resolve => setTimeout(resolve, 100))]);
    fs.writeFileSync(gate, 'release');
    const results = await Promise.all([first.done, second.done]);
    assert.ok(results.every(result => result.code === 0), JSON.stringify(results));
    assert.equal(count(JSON.parse(fs.readFileSync(file, 'utf8'))), 2);
  });
}
