// 3.2, relay side (fake agents, no browser): what the relay arms, feeds and records, and what it refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../src/relay.mjs';
import { createClient } from '../src/client.mjs';
import { verifyBundle } from '../src/ledger.mjs';
import { cleanNondet, ND_CAP } from '../src/nondet.mjs';
import { connectFakeAgent } from './helpers/fake-agent.mjs';

const settle = () => new Promise((r) => setTimeout(r, 100)); // let sockets finish closing: on Windows a forced exit (--test-force-exit) racing them aborts libuv
const world = () => ({ url: 'http://x/', localStorage: {}, indexedDB: {} });

// one production page and one shadow page; `nondet` is what the production click reports it drew
async function withPair(fn, { nondet, relayOpts = {}, shadowHandlers = {}, prodHandlers = {} } = {}) {
  const relay = await createRelay({ port: 0, profile: { volatileKeys: [] }, policy: { default: 'allow' }, ...relayOpts });
  await relay.listen();
  const client = createClient({ port: relay.port, token: relay.token });
  const base = { 'world.capture': world, 'world.restore': () => ({ restored: true }), 'dom.describe': () => ({ effect: 'reversible', label: 'x' }) };
  const prod = await connectFakeAgent(relay.port, { ...base, 'shim.record': () => ({ recording: true }), 'dom.click': () => ({ clicked: true, ...(nondet ? { nondet } : {}) }), ...prodHandlers }, { token: relay.token });
  const shadow = await connectFakeAgent(relay.port, { ...base, 'shim.arm': ({ seed }) => ({ armed: true, seed }), 'shim.feed': () => ({}), 'shim.disarm': () => ({}), 'dom.click': () => ({ clicked: true }), ...shadowHandlers }, { name: 'shadow', token: relay.token });
  try { return await fn({ relay, client, prod, shadow }); } finally { prod.close(); shadow.close(); await relay.close(); await settle(); }
}

const recordSession = async (client) => {
  const sid = await client.startSession({ goal: 'g' });
  await client.cmd('dom.click', { selector: '#a' });
  await client.cmd('dom.click', { selector: '#b' });
  await client.endSession(sid);
  return sid;
};

test('a fork arms the shadow BEFORE it restores the world, feeds each command its recorded draws, and disarms at the end', async () => {
  await withPair(async ({ client, shadow }) => {
    const sid = await recordSession(client);
    const f = await client.fork(sid, { shadow: 'shadow' });
    const order = shadow.seen.map((s) => s.type).filter((t) => /^(shim|world\.restore|dom\.click)/.test(t));
    assert.deepEqual(order, ['shim.arm', 'world.restore', 'shim.feed', 'dom.click', 'shim.feed', 'dom.click', 'shim.disarm'], 'arm first: the restore reloads the page and the shims must be there before its scripts');
    const feeds = shadow.seen.filter((s) => s.type === 'shim.feed').map((s) => s.params);
    assert.deepEqual(feeds, [{ now: [1000, 1001], random: [0.25] }, { now: [1000, 1001], random: [0.25] }], 'what the production page drew is what the shadow page is given');
    assert.equal(f.shims.mode, 'recorded');
    assert.equal(f.shims.recorded_commands, 2);
    const events = await client.events(sid);
    const seed = parseInt(events[0].hash.slice(0, 8), 16) >>> 0;
    assert.equal(f.shims.seed, seed, 'seeded from the recorded session (its session.start hash)');
    assert.equal(shadow.seen.find((s) => s.type === 'shim.arm').params.seed, seed);
    assert.equal(f.shims.base, Date.parse(events[0].ts));
    const start = (await client.events(f.forkSession)).find((e) => e.kind === 'fork.start');
    assert.deepEqual(start.data.shims, f.shims, 'the seed and mode are in the ledger, not only in the reply');
  }, { nondet: { now: [1000, 1001], random: [0.25] } });
});

test('same session, same seed: two forks arm the shadow identically (the shims are deterministic)', async () => {
  await withPair(async ({ client }) => {
    const sid = await recordSession(client);
    const a = await client.fork(sid, { shadow: 'shadow' });
    const b = await client.fork(sid, { shadow: 'shadow' });
    assert.equal(a.shims.seed, b.shims.seed);
    assert.equal(a.shims.base, b.shims.base);
  });
});

test('a session that recorded nothing is replayed with "seeded" shims, and says so', async () => {
  await withPair(async ({ client }) => {
    const sid = await recordSession(client);
    const f = await client.fork(sid, { shadow: 'shadow' });
    assert.equal(f.shims.mode, 'seeded');
    assert.equal(f.shims.recorded_commands, 0);
  });
});

test('recorded draws come from an untrusted page: garbage is dropped and the feed is bounded', async () => {
  const evil = { now: ['x', 5, null, { a: 1 }, 7], random: Array.from({ length: ND_CAP + 50 }, (_, i) => i / 1000), extra: 'ignored' };
  await withPair(async ({ client, shadow }) => {
    const sid = await recordSession(client);
    await client.fork(sid, { shadow: 'shadow' });
    const feed = shadow.seen.filter((s) => s.type === 'shim.feed')[0].params;
    assert.deepEqual(feed.now, [5, 7]);
    assert.equal(feed.random.length, ND_CAP);
    assert.ok(!('extra' in feed));
  }, { nondet: evil });
  assert.equal(cleanNondet('nope'), null);
  assert.equal(cleanNondet([1, 2]), null);
  assert.equal(cleanNondet({ now: [], random: [] }), null);
});

test('a shadow page that cannot arm the shims still replays, and the fork says the shims were unavailable', async () => {
  await withPair(async ({ client, shadow }) => {
    const sid = await recordSession(client);
    const f = await client.fork(sid, { shadow: 'shadow' });
    assert.equal(f.shims.mode, 'unavailable');
    assert.match(f.shims.reason, /unknown command shim\.arm/);
    assert.ok(!shadow.seen.some((s) => s.type === 'shim.feed' || s.type === 'shim.disarm'), 'nothing is fed to a page that is not armed');
    assert.equal(f.steps.length, 2);
  }, { shadowHandlers: { 'shim.arm': () => { throw new Error('unknown command shim.arm'); } } });
});

test('recording is opt-in: production is not touched by default, and with the option it is switched on and written into session.start', async () => {
  await withPair(async ({ client, prod }) => {
    await client.endSession(await client.startSession({}));
    assert.ok(!prod.seen.some((s) => s.type === 'shim.record'), 'no shim command reaches a production page unless the operator asked');
    const start = (await client.events(1))[0];
    assert.equal(start.data.recording, undefined);
  });
  await withPair(async ({ client, prod }) => {
    const sid = await client.startSession({});
    assert.deepEqual(prod.seen.filter((s) => s.type === 'shim.record').map((s) => s.params), [{ on: true }]);
    assert.deepEqual((await client.events(sid))[0].data.recording, { nondeterminism: true });
    await client.endSession(sid);
    // a fork is a shadow session: it never asks for recording
    const f = await client.fork(sid, { shadow: 'shadow' });
    assert.equal((await client.events(f.forkSession))[0].data.recording, undefined);
  }, { relayOpts: { recordNondeterminism: true } });
});

test('fail closed: if recording was requested and cannot be switched on, no session starts', async () => {
  await withPair(async ({ client, relay }) => {
    await assert.rejects(client.startSession({}), (e) => e.status === 409 && /cannot record nondeterminism/.test(e.message));
    assert.deepEqual(relay.ledger.listSessions(), [], 'and nothing was written to the ledger');
  }, { relayOpts: { recordNondeterminism: true }, prodHandlers: { 'shim.record': () => { throw new Error('unknown command shim.record'); } } });
});

test('tamper: editing the seed in a fork.start blob is caught by the bundle check', async () => {
  await withPair(async ({ client }) => {
    const sid = await recordSession(client);
    const f = await client.fork(sid, { shadow: 'shadow' });
    const bundle = await client.bundle(f.forkSession);
    assert.ok(verifyBundle(bundle).ok);
    const ev = bundle.events.find((e) => e.kind === 'fork.start');
    const forged = JSON.parse(JSON.stringify(bundle));
    forged.blobs[ev.data_hash] = forged.blobs[ev.data_hash].replace(`"seed":${f.shims.seed}`, '"seed":1');
    assert.notEqual(forged.blobs[ev.data_hash], bundle.blobs[ev.data_hash], 'the seed was really altered');
    const r = verifyBundle(forged);
    assert.equal(r.ok, false);
    assert.equal(r.badIdx, ev.idx);
  });
});
