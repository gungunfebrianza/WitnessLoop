// 2.2: writes a click makes on the network are reported by the page's observer and compared with the class the page
// declared. Fake agent, no browser: the relay's side of the contract. (The observer itself runs in test/e2e-browser.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelay, cleanEffects } from '../src/relay.mjs';
import { createClient } from '../src/client.mjs';
import { connectFakeAgent } from './helpers/fake-agent.mjs';

const settle = () => new Promise((r) => setTimeout(r, 100)); // let sockets finish closing: on Windows a forced exit (--test-force-exit) racing them aborts libuv

const POST = { method: 'POST', origin: 'http://127.0.0.1:1', path: '/api/pay', body_hash: 'ab'.repeat(32) };

// a page whose #pay button has the given annotation and reports the given effects when clicked
async function withPage({ declared = null, effect = 'reversible', effects = [POST], relayOpts = {}, extra = {}, click } = {}, fn) {
  const relay = await createRelay({ port: 0, policy: { default: 'allow', rules: [] }, checkpoints: 'none', ...relayOpts });
  await relay.listen();
  const client = createClient({ port: relay.port, token: relay.token });
  let agent;
  const handlers = {
    'dom.describe': () => ({ effect, declared, label: 'Pay' }),
    'dom.click': click ? (p) => click(p, agent) : () => ({ clicked: true, observed_effects: effects, ...extra }),
    'world.capture': () => ({ localStorage: {}, indexedDB: {} }),
  };
  agent = await connectFakeAgent(relay.port, handlers, { token: relay.token });
  try { return await fn({ relay, client, agent }); } finally { agent.close(); await relay.close(); await settle(); }
}
const flagsOf = async (client, sid) => (await client.events(sid, { hydrate: true })).filter((e) => e.kind === 'flag');

test('a write under an unannotated click is flagged after dispatch, with method, origin, path and body hash as evidence', async () => {
  await withPage({}, async ({ client, agent }) => {
    const sid = await client.startSession({});
    const out = await client.cmd('dom.click', { selector: '#pay' });
    assert.equal(out.ok, true, 'the click was not blocked: this is detection after the fact');
    assert.ok(agent.seen.some((m) => m.type === 'dom.click'), 'and it reached the page');
    const [flag] = await flagsOf(client, sid);
    assert.equal(flag.type, 'undeclared_effect');
    assert.equal(flag.data.why, 'undeclared network effect');
    assert.equal(flag.data.declared, null, 'no annotation at all');
    assert.deepEqual(flag.data.evidence, [POST]);
    const events = await client.events(sid, { hydrate: true });
    assert.equal(flag.data.command_idx, events.find((e) => e.kind === 'command').idx);
    await client.endSession(sid);
    assert.ok((await client.verify(sid, true)).ok, 'the flag is part of a valid chain');
  });
});

test('an explicit "reversible" label is no defence: the flag records what the page declared', async () => {
  await withPage({ declared: 'reversible' }, async ({ client }) => {
    const sid = await client.startSession({});
    await client.cmd('dom.click', { selector: '#pay' });
    const [flag] = await flagsOf(client, sid);
    assert.equal(flag.data.declared, 'reversible');
  });
});

test('no flag when the write was declared, or when the click only read', async () => {
  await withPage({ effect: 'irreversible', declared: 'irreversible' }, async ({ client }) => {
    const sid = await client.startSession({});
    await client.cmd('dom.click', { selector: '#pay' });
    assert.deepEqual(await flagsOf(client, sid), [], 'a declared irreversible click is expected to write');
  });
  await withPage({ effects: [{ ...POST, method: 'GET' }, { ...POST, method: 'head' }] }, async ({ client }) => {
    const sid = await client.startSession({});
    await client.cmd('dom.click', { selector: '#pay' });
    assert.deepEqual(await flagsOf(client, sid), [], 'GET, HEAD and OPTIONS are not writes');
  });
  await withPage({ effects: [] }, async ({ client }) => {
    const sid = await client.startSession({});
    await client.cmd('dom.click', { selector: '#pay' });
    assert.deepEqual(await flagsOf(client, sid), []);
  });
});

test('nothing but method, origin, path and a body hash is kept: a page cannot put a body, headers or a token in the ledger through this channel', async () => {
  const dirty = { ...POST, body: 'password=hunter2', headers: { authorization: 'Bearer s3cr3t' }, path: '/api/pay', cookie: 'sid=abc' };
  await withPage({ effects: [dirty] }, async ({ client }) => {
    const sid = await client.startSession({});
    await client.cmd('dom.click', { selector: '#pay' });
    await client.endSession(sid);
    const all = JSON.stringify(await client.events(sid, { hydrate: true }));
    for (const secret of ['hunter2', 's3cr3t', 'sid=abc']) assert.ok(!all.includes(secret), `${secret} must not reach the ledger`);
    assert.deepEqual((await flagsOf(client, sid))[0].data.evidence, [POST]);
  });
  assert.deepEqual(cleanEffects('nope'), []);
  assert.equal(cleanEffects(new Array(500).fill(POST)).length, 50, 'bounded');
  assert.equal(cleanEffects([{ method: 'POST', path: 'x'.repeat(5000) }])[0].path.length, 200);
});

test('a native submit unloads the page before it can reply: what it pushed over the link is still recorded and flagged', async () => {
  await withPage({
    click: async (_p, agent) => {
      agent.ws.send(JSON.stringify({ kind: 'observed', effects: [{ ...POST, body_hash: null }] }));
      agent.ws.close(); // the page navigated away
      await new Promise(() => {});
    },
  }, async ({ client }) => {
    const sid = await client.startSession({});
    const out = await client.cmd('dom.click', { selector: '#pay' }).catch((e) => e);
    assert.ok(out instanceof Error || out.ok === false, 'the click itself failed: the agent went away');
    const events = await client.events(sid, { hydrate: true });
    const cmd = events.find((e) => e.kind === 'command');
    assert.match(cmd.data.error, /disconnected/);
    assert.equal(cmd.data.observed_effects[0].path, '/api/pay');
    const [flag] = events.filter((e) => e.kind === 'flag');
    assert.equal(flag.data.evidence[0].method, 'POST');
  });
});

test('replay-verify does not diverge because the shadow copy lives on another origin', async () => {
  const relay = await createRelay({ port: 0, policy: { default: 'allow', rules: [] } });
  await relay.listen();
  const client = createClient({ port: relay.port, token: relay.token });
  const page = (origin) => ({
    'dom.describe': () => ({ effect: 'reversible', declared: null, label: 'Pay' }),
    'dom.click': () => ({ clicked: true, observed_effects: [{ ...POST, origin }] }),
    'world.capture': () => ({ localStorage: {}, indexedDB: {} }),
    'world.restore': () => ({ restored: true }),
  });
  const prod = await connectFakeAgent(relay.port, page('http://127.0.0.1:1'), { name: 'default', token: relay.token });
  const shadow = await connectFakeAgent(relay.port, page('http://127.0.0.1:2'), { name: 'shadow', token: relay.token });
  try {
    const sid = await client.startSession({});
    await client.cmd('dom.click', { selector: '#pay' });
    await client.endSession(sid);
    const r = await client.replayVerify(sid, { shadow: 'shadow' });
    assert.equal(r.reproduced, true, JSON.stringify(r.firstDivergence));
  } finally { prod.close(); shadow.close(); await relay.close(); await settle(); }
});

test('an observed entry the relay cannot read as a safe method is treated as a write, not skipped', async () => {
  await withPage({ effects: [{ origin: 'http://x', path: '/p' }] }, async ({ client }) => {
    const sid = await client.startSession({});
    await client.cmd('dom.click', { selector: '#pay' });
    assert.equal((await flagsOf(client, sid)).length, 1);
  });
});
