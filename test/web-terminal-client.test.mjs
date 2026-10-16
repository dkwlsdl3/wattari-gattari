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
const { initTerminal, nativeProgress } = await import('../src/web/terminal.mjs');
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
  let recorded = false;
  const send = controls.sendText('must not reach the previous session', () => { recorded = true; });
  const rejected = assert.rejects(send, /메시지는 전송하지 않았습니다/);
  select('waga-proof-b'); select('waga-proof-a');
  await rejected;
  assert.equal(recorded, false);
});

test('an actual connection failure retains its original reason', async t => {
  const { controls } = fixture(t, async () => { throw Error('permission denied from provider'); });
  await assert.rejects(controls.open(), /permission denied from provider/);
});


test('native progress uses only the status row, excluding response text and native keyboard commands', () => {
  const screen = [
    'A response that belongs in the conversation.',
    'Working (45s • esc to interrupt) · 3 background terminals running · /ps to view · /stop to close',
    '└ Tip: Use /title to choose what appears in your terminal’s title.',
    '› Ask Codex to do anything',
  ];
  assert.equal(nativeProgress(screen), 'Working (45s) · 3 background terminals running');
  assert.equal(nativeProgress(['› Explain Working (45s • esc to interrupt)', 'A completed response']), '');
  assert.equal(nativeProgress(['› Ask Codex to do anything']), '');
});
