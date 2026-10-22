import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import test from 'node:test';

// Supply already-rendered screen text; real VT rendering is checked in Chromium.
const terminalUrl = `data:text/javascript,${encodeURIComponent(`export class Terminal {
  constructor() { this.rows=30; this.screen=[]; this.buffer={active:{viewportY:0,getLine:i=>({translateToString:()=>this.screen[i]??''})}}; }
  open() {} dispose() {} resize() {} onData(fn) { this.data=fn; }
  paste(value) { this.data(value); }
  write(value,done) { this.screen=value.split('\\n'); done(); }
}`)}`;
const hooks = registerHooks({ resolve(specifier, context, next) {
  return specifier === '/xterm.mjs' ? { url: terminalUrl, shortCircuit: true } : next(specifier, context);
} });
const { initTerminal } = await import('../src/web/terminal.mjs');
hooks.deregister();

async function until(check) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() >= deadline) throw Error('terminal UI condition did not arrive');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function fixture(t) {
  const originals = { document: globalThis.document, WebSocket: globalThis.WebSocket, location: globalThis.location };
  const elements = new Map(), sockets = [];
  function element(tag) {
    return { tag, hidden: true, children: [], textContent: '', listeners: new Map(),
      append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; },
      addEventListener(type, fn) { this.listeners.set(type, fn); },
      querySelectorAll() { return this.children.flatMap(item => item.tag === 'button' ? [item] : item.querySelectorAll()); },
    };
  }
  globalThis.document = {
    createElement: element,
    querySelector(selector) { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); },
  };
  globalThis.location = { protocol: 'http:', host: 'waga-proof.invalid' };
  globalThis.WebSocket = class extends EventTarget {
    static OPEN = 1;
    constructor() { super(); this.readyState = 1; this.writes = []; this.ack = true; sockets.push(this); }
    emit(message) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
    send(raw) { const message = JSON.parse(raw); this.writes.push(message); if (this.ack) queueMicrotask(() => this.emit({ type: 'input-result', id: message.id })); }
    close() { this.readyState = 3; }
  };
  let session = { id: 'claude:waga-proof-a', provider: 'claude', status: 'needs-input' };
  const controls = initTerminal({ api: async () => ({ ticket: 'waga-proof-ticket' }), selected: () => session });
  t.after(() => { controls.disconnect(); Object.assign(globalThis, originals); });
  return { controls, elements, sockets,
    select(id) { session = { ...session, id }; controls.sync(id); },
    async connect(screen = '❯ Send a message') {
      const ready = controls.open();
      await new Promise(resolve => setImmediate(resolve));
      const socket = sockets.at(-1); socket.emit({ type: 'output', data: screen });
      await ready; return socket;
    },
  };
}

test('successful web submission sends the text and Enter with its recorded work id', async t => {
  const { controls, connect } = fixture(t), socket = await connect();
  assert.equal(await controls.sendText('user text', async () => ({ id: 'work-a', deliveryText: 'recorded text' })), true);
  assert.deepEqual(socket.writes.map(({ data, workId }) => ({ data, workId })), [
    { data: 'recorded text', workId: undefined }, { data: '\r', workId: 'work-a' },
  ]);
});

test('answering an approval once leaves a following unknown question accessible', async t => {
  const { connect, elements } = fixture(t);
  const screen = fs.readFileSync(new URL('./fixtures/native-questions/claude-command.txt', import.meta.url), 'utf8');
  const socket = await connect(screen);
  const yes = elements.get('#question-choices').querySelectorAll().find(button => button.textContent === 'Yes');
  yes.listeners.get('click')(); yes.listeners.get('click')();
  assert.deepEqual(socket.writes.map(message => message.data), ['1\r']);
  socket.emit({ type: 'output', data: 'How should the tool proceed?\n❯ Provide further details' });
  await until(() => elements.get('#session-question').hidden);
  assert.equal(elements.get('#native-fallback').hidden, false);
});

test('switching sessions while recording a message does not paste or submit it', async t => {
  const { controls, connect, select } = fixture(t), socket = await connect();
  let finish, started;
  const recording = new Promise(resolve => { started = resolve; });
  const send = controls.sendText('draft', () => { started(); return new Promise(resolve => { finish = resolve; }); });
  const rejected = assert.rejects(send, /입력 대상이 변경/);
  await recording; select('claude:waga-proof-b'); finish({ id: 'work-a' });
  await rejected;
  assert.deepEqual(socket.writes, []);
});

test('a late input acknowledgment after a session switch cannot submit the old draft', async t => {
  const { controls, connect, select } = fixture(t), previous = await connect();
  previous.ack = false;
  const send = controls.sendText('old draft');
  const rejected = assert.rejects(send, /입력 연결이 종료됐습니다/);
  await until(() => previous.writes.length > 0);
  select('claude:waga-proof-b'); await rejected;
  const current = await connect();
  previous.emit({ type: 'input-result', id: previous.writes[0].id });
  await controls.sendText('new draft');
  assert.deepEqual(previous.writes.map(message => message.data), ['old draft']);
  assert.deepEqual(current.writes.map(message => message.data), ['new draft', '\r']);
});
