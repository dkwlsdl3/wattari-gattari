import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import pty from 'node-pty';

const nativeId = '11111111-2222-4333-8444-555555555555';

async function directProof(t, fail) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'waga-proof-direct-'));
  const marker = path.join(root, 'permissions');
  const runner = path.join(root, 'runner.mjs');
  const command = `
    const fs = require('node:fs');
    process.stdin.setRawMode(true);
    process.stdout.write('\x1b]2;${nativeId}\x07\x1b]11;?\x07');
    process.stdin.once('data', reply => {
      require('node:assert/strict').equal(reply.toString(), '\x1b]11;rgb:ffff/ffff/ffff\x07');
      process.stdout.write('PALETTE_OK\x1b[6n');
      process.stdin.once('data', position => {
        require('node:assert/strict').equal(position.toString(), '\x1b[17;1R');
        process.stdout.write('CURSOR_OK› Ask Codex');
        process.stdin.on('data', () => {
          process.stdout.write(fs.existsSync(${JSON.stringify(marker)}) ? 'VALID_POLICY' : 'BAD_POLICY');
          process.exit(0);
        });
      });
    });`;
  fs.writeFileSync(runner, `
    import fs from 'node:fs';
    import { DirectWorkspace } from ${JSON.stringify(new URL('../src/direct-workspace.mjs', import.meta.url).href)};
    const workspace = new DirectWorkspace({ eventLog: { record() {} } });
    try {
      const result = await workspace.focusOrOpen({ provider: 'codex', id: 'codex:${nativeId}', nativeId: '${nativeId}' }, {
        command: process.execPath, args: ['-e', ${JSON.stringify(command)}], cwd: ${JSON.stringify(root)},
        afterAttach: async () => {
          process.stdout.write('PREPARING');
          await new Promise(resolve => setTimeout(resolve, 150));
          if (${fail}) throw Error('SYNC_FAILED');
          fs.writeFileSync(${JSON.stringify(marker)}, 'verified');
          process.stdout.write('POLICY_READY');
        }
      });
      process.stdout.write('RETURNED:' + result.code);
    } catch(error) { process.stdout.write('CAUGHT:' + error.message); }
    process.stdin.pause();`);
  const child = pty.spawn(process.execPath, [runner], { cwd: root, env: process.env, name: 'xterm-256color', cols: 100, rows: 30 });
  let output = '', palette = false, cursor = false, early = false, later = false, exited = false;
  t.after(() => { if (!exited) child.kill(); fs.rmSync(root, { recursive: true, force: true }); });
  child.onData(data => {
    output += data;
    if (!palette && output.includes('\x1b]11;?\x07')) { palette = true; child.write('\x1b]11;rgb:ffff/ffff/ffff\x07'); }
    if (!cursor && output.includes('\x1b[6n')) { cursor = true; child.write('\x1b[17;1R'); }
    if (!early && output.includes('› Ask Codex')) { early = true; child.write('early\r'); }
    if (!later && output.includes('POLICY_READY')) { later = true; child.write('after\r'); }
  });
  await new Promise(resolve => child.onExit(() => { exited = true; resolve(); }));
  return output;
}

test('direct input reaches the native process only after post-attach permissions pass', { timeout: 5000 }, async t => {
  const output = await directProof(t, false);
  assert.match(output, /PALETTE_OK.*PREPARING.*POLICY_READY.*VALID_POLICY/s);
  assert.doesNotMatch(output, /BAD_POLICY/);
  assert.match(output, /RETURNED:0/);
});

test('failed direct permission synchronization closes the frontend without admitting input', { timeout: 5000 }, async t => {
  const output = await directProof(t, true);
  assert.match(output, /CAUGHT:SYNC_FAILED/);
  assert.doesNotMatch(output, /BAD_POLICY|VALID_POLICY/);
});
