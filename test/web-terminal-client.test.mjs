import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

// Resolve the browser's static routes to the same installed modules served by Waga.
const aliases = new Map([
  ['/xterm.mjs', import.meta.resolve('@xterm/xterm/lib/xterm.mjs')],
  ['/xterm-fit.mjs', import.meta.resolve('@xterm/addon-fit/lib/addon-fit.mjs')],
]);
const hooks = registerHooks({ resolve(specifier, context, next) {
  return aliases.has(specifier) ? { url: aliases.get(specifier), shortCircuit: true } : next(specifier, context);
} });
const { initTerminal } = await import('../src/web/terminal.mjs');
hooks.deregister();

function fixture(t, api = () => new Promise(() => {})) {
  const original = globalThis.document, elements = new Map();
  globalThis.document = { querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, { hidden: true, textContent: '', replaceChildren() {} });
    return elements.get(selector);
  } };
  let selected = { id: 'waga-proof-a', provider: 'codex' };
  const controls = initTerminal({ api, selected: () => selected });
  t.after(() => { controls.sync(''); globalThis.document = original; });
  return { controls, select(id) { selected = { id, provider: 'claude' }; controls.sync(id); } };
}

test('browsing away from a pending connection cancels silently instead of reporting a send error', async t => {
  const { controls, select } = fixture(t), warnings = [];
  const pending = controls.open().catch(error => warnings.push(error.message));
  select('waga-proof-b');
  await pending;
  assert.deepEqual(warnings, []);
});

test('a message waiting for a cancelled connection remains unsent even when the same session is selected again', async t => {
  const { controls, select } = fixture(t);
  const send = controls.sendText('must not reach the previous session');
  const rejected = assert.rejects(send, /메시지는 전송하지 않았습니다/);
  select('waga-proof-b'); select('waga-proof-a');
  await rejected;
});

test('an actual connection failure retains its original reason', async t => {
  const { controls } = fixture(t, async () => { throw Error('permission denied from provider'); });
  await assert.rejects(controls.open(), /permission denied from provider/);
});


test('changing session immediately clears the previous native output', async t => {
  const { controls, select } = fixture(t);
  const pending = controls.open();
  const panel = document.querySelector('#live-output'), output = document.querySelector('#live-output-text');
  panel.hidden = false; output.textContent = 'previous session tool output';
  select('waga-proof-b');
  await pending;
  assert.equal(panel.hidden, true);
  assert.equal(output.textContent, '');
});
