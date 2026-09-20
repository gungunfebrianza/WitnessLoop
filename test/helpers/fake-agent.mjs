// A stand-in for a browser page running src/agent/inject.js: connects over the real WebSocket
// protocol and answers commands from a handler table. No browser needed.
import http from 'node:http';
import { handleWitnessRequest } from '../../src/adapter.mjs';
import { initialState, transfer } from '../../examples/bank/model.mjs';

export async function connectFakeAgent(port, handlers, { name = 'default', origin = '', adapter = false, loadId = `fake-${Math.random().toString(36).slice(2)}` } = {}) {
  const seen = [];
  const url = `ws://127.0.0.1:${port}/agent?name=${encodeURIComponent(name)}&loadId=${loadId}&origin=${encodeURIComponent(origin)}&adapter=${adapter ? 1 : 0}`;
  const ws = new WebSocket(url);
  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.kind !== 'command') return;
    seen.push({ type: msg.type, params: msg.params });
    const h = handlers[msg.type];
    try {
      const result = h ? await h(msg.params) : {};
      ws.send(JSON.stringify({ kind: 'reply', id: msg.id, ok: true, result }));
    } catch (e) {
      ws.send(JSON.stringify({ kind: 'reply', id: msg.id, ok: false, error: e.message }));
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('fake agent could not connect')); });
  // wait until the relay has registered it
  for (let i = 0; i < 100; i++) {
    const h = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    if (h.result.agents.includes(name)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  return { seen, ws, loadId, close: () => ws.close() };
}

// A fake bank "page + server": form fields live in page localStorage, balances on the server.
export async function startFakeBank(relayPort, { name = 'default' } = {}) {
  const state = { bank: initialState(), form: { to: '', amount: '' } };
  const server = http.createServer((req, res) => {
    if (handleWitnessRequest(req, res, { getState: () => state.bank, setState: (s) => { state.bank = s; } })) return;
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const handlers = {
    ping: () => ({ pong: true }),
    'page.info': () => ({ url: `${origin}/`, title: 'Fake bank' }),
    'dom.query': ({ selector }) => (selector === '#balances'
      ? { matchCount: 1, items: [{ id: 'balances', text: JSON.stringify(state.bank.balances), data: { ...state.bank.balances, fees: state.bank.fees } }] }
      : { matchCount: 0, items: [] }),
    'dom.describe': ({ selector }) => (selector === '#send'
      ? { effect: 'irreversible', label: 'Send', preview: { to: state.form.to, amount: state.form.amount } }
      : { effect: 'reversible', label: selector }),
    'dom.fill': ({ selector, value }) => { state.form[selector.replace('#', '')] = value; return { filled: true, value }; },
    'dom.click': ({ selector }) => {
      if (selector !== '#send') return { clicked: true };
      const r = transfer(state.bank, { from: 'alice', to: state.form.to, amount: state.form.amount });
      if (!r.ok) throw new Error(r.error);
      state.afterTransfer?.(state.bank);
      state.form = { to: '', amount: '' };
      return { clicked: true, tx: r.tx.id };
    },
    'world.capture': () => ({ url: `${origin}/`, localStorage: { form: JSON.stringify(state.form) }, indexedDB: {} }),
    'world.restore': ({ world }) => { state.form = JSON.parse(world.localStorage.form ?? '{"to":"","amount":""}'); return { restored: true }; },
  };
  const agent = await connectFakeAgent(relayPort, handlers, { name, origin, adapter: true });
  return { state, agent, origin, close: async () => { agent.close(); await new Promise((r) => server.close(r)); server.closeAllConnections?.(); } };
}

export const bankProfile = {
  volatileKeys: ['at'],
  invariant: async (world) => {
    const { INITIAL_TOTAL, totalMoney } = await import('../../examples/bank/model.mjs');
    const total = totalMoney(world.server);
    return total === INITIAL_TOTAL ? { ok: true } : { ok: false, why: `money not conserved: total ${total} != ${INITIAL_TOTAL} (${total - INITIAL_TOTAL} cents)` };
  },
};
