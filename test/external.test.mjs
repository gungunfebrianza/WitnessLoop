// 3.3: third-party responses are recorded (opt-in, named origins) into content-addressed blobs and served back to a shadow replay,
// which never touches the network. Relay side with fake agents first, then a real page against a stub provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserSkip } from '../examples/lib/browser.mjs';
import { startStage } from '../examples/lib/stage.mjs';
import { sendJson } from '../examples/lib/server.mjs';
import { createRelay } from '../src/relay.mjs';
import { createClient } from '../src/client.mjs';
import { verifyBundle } from '../src/ledger.mjs';
import { validateOrigins, cleanExternal, EXTERNAL_NOTE, EXT_BODY_CAP } from '../src/external.mjs';
import { findOp } from '../src/ops.mjs';
import { parseArgs } from '../src/cli.mjs';
import { connectFakeAgent } from './helpers/fake-agent.mjs';
import { fixtureApp } from './helpers/fixture-app.mjs';
import { startProvider } from './helpers/provider.mjs';

const skip = browserSkip();
const settle = () => new Promise((r) => setTimeout(r, 100)); // let sockets finish closing: on Windows a forced exit (--test-force-exit) racing them aborts libuv
const ORIGIN = 'https://api.example.com';
const BODY = Buffer.from('{"quote":42,"secret":"provider-body-SECRET"}').toString('base64');
const call = (over = {}) => ({ method: 'GET', origin: ORIGIN, path: '/quote', query_hash: 'a'.repeat(64), req_hash: 'b'.repeat(64), status: 200, content_type: 'application/json', bytes: 43, body_b64: BODY, ...over });

async function withPair(fn, { relayOpts = {}, external = [call()], prodHandlers = {}, shadowHandlers = {} } = {}) {
  const relay = await createRelay({ port: 0, profile: { volatileKeys: [] }, policy: { default: 'allow' }, ...relayOpts });
  await relay.listen();
  const client = createClient({ port: relay.port, token: relay.token });
  const base = { 'world.capture': () => ({ url: 'http://x/', localStorage: {}, indexedDB: {} }), 'world.restore': () => ({ restored: true }), 'dom.describe': () => ({ effect: 'reversible', label: 'x' }) };
  const prod = await connectFakeAgent(relay.port, { ...base, 'external.arm': () => ({}), 'dom.click': () => ({ clicked: true, external }), ...prodHandlers }, { token: relay.token });
  const shadow = await connectFakeAgent(relay.port, { ...base, 'external.arm': () => ({}), 'external.feed': () => ({}), 'shim.arm': () => ({}), 'shim.feed': () => ({}), 'shim.disarm': () => ({}), 'dom.click': () => ({ clicked: true }), ...shadowHandlers }, { name: 'shadow', token: relay.token });
  try { return await fn({ relay, client, prod, shadow }); } finally { prod.close(); shadow.close(); await relay.close(); await settle(); }
}
const record = async (client) => { const sid = await client.startSession({}); await client.cmd('dom.click', { selector: '#buy' }); await client.endSession(sid); return sid; };
const OPTS = { relayOpts: { externalOrigins: [ORIGIN] } };

test('off by default: with no origins named, whatever the page reports is dropped and nothing is written', async () => {
  await withPair(async ({ client, prod }) => {
    const sid = await record(client);
    assert.ok(!prod.seen.some((s) => s.type === 'external.arm'));
    const cmd = (await client.events(sid)).find((e) => e.kind === 'command');
    assert.equal(cmd.data.external, undefined);
    assert.equal(cmd.data.result.external, undefined, 'the raw report is not kept in the result either');
    assert.equal((await client.events(sid))[0].data.recording, undefined);
  });
});

test('recorded bodies live in their own blobs, travel in the bundle, and are covered by verify', async () => {
  await withPair(async ({ client, prod }) => {
    const sid = await record(client);
    assert.deepEqual(prod.seen.filter((s) => s.type === 'external.arm').map((s) => s.params), [{ mode: 'record', origins: [ORIGIN] }]);
    const events = await client.events(sid);
    assert.deepEqual(events[0].data.recording, { external: [ORIGIN] });
    const cmd = events.find((e) => e.kind === 'command');
    assert.equal(cmd.data.external.length, 1);
    const x = cmd.data.external[0];
    assert.deepEqual([x.method, x.origin, x.path, x.status], ['GET', ORIGIN, '/quote', 200]);
    assert.match(x.response_hash, /^[0-9a-f]{64}$/);
    assert.ok(!('body_b64' in x), 'the command event holds a hash, not the body');
    assert.equal(cmd.data.result.external, undefined);

    const bundle = await client.bundle(sid);
    assert.ok(bundle.blobs[x.response_hash], 'the body blob is in the bundle');
    assert.equal(JSON.parse(bundle.blobs[x.response_hash]).body_b64, BODY);
    assert.ok(verifyBundle(bundle).ok);

    const forged = JSON.parse(JSON.stringify(bundle));
    forged.blobs[x.response_hash] = forged.blobs[x.response_hash].replace(BODY.slice(0, 8), 'AAAAAAAA');
    const r = verifyBundle(forged);
    assert.equal(r.ok, false);
    assert.equal(r.badIdx, cmd.idx);
    assert.match(r.problems[0].reason, /external response does not match its hash/);

    const stripped = JSON.parse(JSON.stringify(bundle));
    delete stripped.blobs[x.response_hash];
    assert.match(verifyBundle(stripped).problems[0].reason, /external response blob missing/);
  }, OPTS);
});

test('the page is untrusted: other origins are dropped, oversize bodies are marked truncated, the query string is only ever a hash', async () => {
  const evil = [call(), call({ origin: 'https://evil.example', path: '/steal' }), call({ path: '/big', body_b64: 'A'.repeat(EXT_BODY_CAP * 2), truncated: false }), call({ path: '/t', truncated: true, body_b64: BODY }), { origin: ORIGIN, path: 5, method: {} }];
  await withPair(async ({ client }) => {
    const sid = await record(client);
    const ext = (await client.events(sid)).find((e) => e.kind === 'command').data.external;
    assert.deepEqual(ext.map((x) => x.path), ['/quote', '/big', '/t', ''], 'the entry for another origin is gone; the malformed one is reduced to nothing useful');
    assert.equal(ext[1].truncated, true);
    assert.equal(ext[1].response_hash, undefined, 'a body over the cap is not stored');
    assert.equal(ext[2].truncated, true, 'a page that says it truncated is believed');
    const text = Object.values((await client.bundle(sid)).blobs).join('\n');
    assert.ok(!text.includes('evil.example'));
  }, { ...OPTS, external: evil });
  const c = cleanExternal([call({ path: '/q?token=SECRET' })], [ORIGIN])[0];
  assert.ok(!('search' in c) && !('url' in c), 'there is nowhere to keep a query string');
});

test('configuration fails closed: bad origins stop the relay; an agent that cannot record refuses the session', async () => {
  for (const bad of [['https://api.example.com/path'], ['not a url'], 'https://x.example', ['ftp://x.example'], [5]]) await assert.rejects(createRelay({ port: 0, externalOrigins: bad }), /externalOrigins/, JSON.stringify(bad));
  assert.deepEqual(validateOrigins(['https://a.example', 'http://127.0.0.1:8080/']), ['https://a.example', 'http://127.0.0.1:8080']);
  await withPair(async ({ client, relay }) => {
    await assert.rejects(client.startSession({}), (e) => e.status === 409 && /cannot record external responses/.test(e.message));
    assert.deepEqual(relay.ledger.listSessions(), []);
  }, { ...OPTS, prodHandlers: { 'external.arm': () => { throw new Error('unknown command external.arm'); } } });
});

test('a fork arms the shadow for replay before restoring, feeds each command its recorded calls with bodies, and says what it replayed against', async () => {
  await withPair(async ({ client, shadow }) => {
    const sid = await record(client);
    const f = await client.fork(sid, { shadow: 'shadow' });
    const seen = shadow.seen.filter((s) => /^(external|world\.restore|dom\.click)/.test(s.type)).map((s) => s.type);
    assert.deepEqual(seen, ['external.arm', 'world.restore', 'external.feed', 'dom.click', 'external.arm']);
    const armed = shadow.seen.filter((s) => s.type === 'external.arm').map((s) => s.params);
    assert.deepEqual(armed, [{ mode: 'replay', origins: [ORIGIN] }, { mode: 'off', origins: [] }]);
    const feed = shadow.seen.find((s) => s.type === 'external.feed').params.calls;
    assert.equal(feed.length, 1);
    assert.equal(feed[0].body_b64, BODY, 'the body came from its blob');
    assert.equal(feed[0].path, '/quote');
    assert.equal(f.replayedAgainstRecordedExternal, true);
    assert.equal(f.note, EXTERNAL_NOTE);
    assert.equal(f.note, 'replayed against recorded external responses');
    assert.equal(f.external.mode, 'recorded');
    assert.equal(f.external.recorded_calls, 1);
    const start = (await client.events(f.forkSession)).find((e) => e.kind === 'fork.start');
    assert.deepEqual(start.data.external, { mode: 'recorded', origins: [ORIGIN], recorded_calls: 1 }, 'written into the ledger before the replay ran');
    const rv = await client.replayVerify(sid, { shadow: 'shadow' });
    assert.equal(rv.replayedAgainstRecordedExternal, true);
    assert.equal(rv.note, EXTERNAL_NOTE);
  }, OPTS);
});

test('fail closed: a shadow that cannot switch to recorded responses is not replayed against the live third party', async () => {
  await withPair(async ({ client, relay, shadow }) => {
    const sid = await record(client);
    const before = relay.ledger.listSessions().length;
    await assert.rejects(client.fork(sid, { shadow: 'shadow' }), (e) => e.status === 409 && /refusing to replay against the live third party/.test(e.message));
    assert.equal(relay.ledger.listSessions().length, before, 'no fork session was created');
    assert.ok(!shadow.seen.some((s) => s.type === 'world.restore' || s.type === 'dom.click'), 'nothing ran on the shadow');
  }, { ...OPTS, shadowHandlers: { 'external.arm': () => { throw new Error('unknown command external.arm'); } } });
});

test('a session that recorded no external responses is forked without them and does not claim to have been', async () => {
  await withPair(async ({ client, shadow }) => {
    const sid = await record(client);
    const f = await client.fork(sid, { shadow: 'shadow' });
    assert.equal(f.replayedAgainstRecordedExternal, undefined);
    assert.equal(f.note, undefined);
    assert.equal(f.external.mode, 'off');
    assert.ok(!shadow.seen.some((s) => s.type.startsWith('external.')));
  });
});

// ---- a real page against a stub provider ----
async function withProviderStage(fn, relayOptions) {
  const provider = await startProvider();
  const api = async (req, res, url) => { if (url.pathname === '/config.json') { sendJson(res, 200, { provider: provider.origin }); return true; } return false; };
  const stage = await startStage('provider', { def: fixtureApp('provider', {}, { api }), relayOptions: relayOptions(provider) });
  try { return await fn({ stage, provider }); } finally { await stage.close(); await provider.close(); await settle(); }
}
const buy = async (client, selector = '#buy') => { const sid = await client.startSession({}); await client.cmd('dom.click', { selector }); await client.endSession(sid); return sid; };
const ls = async (stage, agent, key) => (await stage.world(agent)).page.localStorage[key];

test('replayed against the recording, with the provider gone: reproduces, says so, and the network is never used', { skip: skip ?? false, timeout: 120000 }, async () => {
  await withProviderStage(async ({ stage, provider }) => {
    const sid = await buy(stage.client);
    assert.equal(await ls(stage, 'default', 'quote'), '1', 'production got the provider\'s first answer');
    assert.deepEqual(provider.calls, ['GET /quote?sku=1']);
    const cmd = (await stage.client.events(sid)).find((e) => e.kind === 'command');
    assert.equal(cmd.data.external.length, 1);
    assert.equal(cmd.data.external[0].path, '/quote');
    assert.ok(!JSON.stringify(cmd.data).includes('sku'), 'the query string was not stored');

    await provider.close(); // from here on the provider does not exist
    const r = await stage.client.replayVerify(sid, { shadow: 'shadow' });
    assert.equal(r.reproduced, true, JSON.stringify(r));
    assert.equal(r.replayedAgainstRecordedExternal, true);
    assert.equal(r.note, 'replayed against recorded external responses');
    assert.equal(r.external.served, 1);
    assert.deepEqual(r.external.missed, []);
    assert.equal(await ls(stage, 'shadow', 'quote'), '1', 'the shadow page was answered from the recording');
    assert.equal(provider.calls.length, 1, 'and the provider saw no second request');
  }, (p) => ({ externalOrigins: [p.origin] }));
});

test('control: with no recording the replay reaches the live provider, gets a different answer, and does not reproduce', { skip: skip ?? false, timeout: 120000 }, async () => {
  await withProviderStage(async ({ stage, provider }) => {
    const sid = await buy(stage.client);
    const r = await stage.client.replayVerify(sid, { shadow: 'shadow' });
    assert.equal(r.reproduced, false);
    assert.equal(r.replayedAgainstRecordedExternal, undefined);
    assert.equal(await ls(stage, 'shadow', 'quote'), '2');
    assert.equal(provider.calls.length, 2, 'the shadow really did call the provider');
  }, () => ({}));
});

test('a request the recording does not cover is refused and reported, never sent: fetch fails, XHR is blocked, the provider sees nothing', { skip: skip ?? false, timeout: 120000 }, async () => {
  await withProviderStage(async ({ stage, provider }) => {
    const sid = await buy(stage.client);
    await provider.close();
    const cmdIdx = (await stage.client.events(sid)).find((e) => e.kind === 'command').idx;

    const f = await stage.client.fork(sid, { shadow: 'shadow', override: { [cmdIdx]: { selector: '#again' } } });
    assert.equal(f.external.served, 0);
    assert.equal(f.external.missed.length, 1);
    assert.deepEqual([f.external.missed[0].method, f.external.missed[0].path, f.external.missed[0].reason], ['GET', '/other', 'no recorded response']);
    assert.match(await stage.shadow.browser.evaluate('document.getElementById("out").textContent'), /failed: witnessloop: no recorded response for GET .*\/other; the network was not used/);
    assert.equal(await ls(stage, 'shadow', 'other'), undefined);

    const x = await stage.client.fork(sid, { shadow: 'shadow', override: { [cmdIdx]: { selector: '#xhr' } } });
    assert.equal(x.external.missed.length, 1);
    assert.match(x.external.missed[0].reason, /blocked/);
    assert.match(await stage.shadow.browser.evaluate('document.getElementById("out").textContent'), /^blocked: witnessloop: /);
    assert.equal(provider.calls.length, 1, 'the provider was asked exactly once: by production');
  }, (p) => ({ externalOrigins: [p.origin] }));
});

test('CLI and MCP table: serve takes --record-external (repeatable) and --record-nondeterminism, and the op still parses without them', () => {
  const op = findOp('serve');
  assert.deepEqual(parseArgs(op, ['--record-external', 'https://a.example', '--record-external', 'https://b.example', '--record-nondeterminism']), { recordExternal: ['https://a.example', 'https://b.example'], recordNondeterminism: true });
  assert.deepEqual(parseArgs(op, ['--no-open']), { noOpen: true });
  assert.match(op.usage, /--record-external <origin>/);
  assert.match(op.usage, /--record-nondeterminism/);
});

test('the recorded bodies and the origin list are part of an exported bundle that verifies offline', { skip: skip ?? false, timeout: 120000 }, async () => {
  await withProviderStage(async ({ stage }) => {
    const sid = await buy(stage.client);
    const bundle = await stage.client.bundle(sid);
    assert.ok(verifyBundle(bundle).ok);
    const cmd = bundle.events.find((e) => e.kind === 'command');
    const ref = JSON.parse(bundle.blobs[cmd.data_hash]).external[0];
    assert.deepEqual(JSON.parse(Buffer.from(JSON.parse(bundle.blobs[ref.response_hash]).body_b64, 'base64').toString()), { n: 1 });
  }, (p) => ({ externalOrigins: [p.origin] }));
});
