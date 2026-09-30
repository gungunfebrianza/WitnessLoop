// 3.1: profile.redactKeys keeps secrets out of every blob (and so out of an exported bundle); a checkpoint says what it holds and what it cannot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelay } from '../src/relay.mjs';
import { createClient } from '../src/client.mjs';
import { redactWorld, validateRedactKeys, REDACTED } from '../src/world.mjs';
import { connectFakeAgent } from './helpers/fake-agent.mjs';

const settle = () => new Promise((r) => setTimeout(r, 100)); // let sockets finish closing: on Windows a forced exit (--test-force-exit) racing them aborts libuv
const SECRET = 'sk-live-TOP-SECRET-1234';
const COOKIE = 'session-cookie-SECRET-9876';
const DBPASS = 'hunter2-SECRET';

const page = () => ({
  url: 'http://x/', meta: { notCaptured: ['HttpOnly cookies (document.cookie cannot read them)'] },
  localStorage: { api_token: SECRET, theme: 'dark' }, sessionStorage: { Csrf: 'csrf-SECRET' }, cookies: { sid: COOKIE, lang: 'en' }, serviceWorkers: [],
  indexedDB: { db: { version: 1, stores: { users: { keyPath: 'id', autoIncrement: false, rows: [{ key: 1, value: { id: 1, name: 'alice', password: DBPASS } }], indexes: [] } } } },
});

async function withAgent(profile, fn) {
  const relay = await createRelay({ port: 0, profile, policy: { default: 'allow' } });
  await relay.listen();
  const client = createClient({ port: relay.port, token: relay.token });
  const seen = {};
  const agent = await connectFakeAgent(relay.port, {
    'world.capture': () => page(),
    'dom.describe': ({ selector }) => (selector === '#go' ? { effect: 'irreversible', label: 'Go', preview: { to: 'x' } } : { effect: 'reversible', label: selector }),
    'dom.click': () => ({ clicked: true }),
    'dom.fill': ({ value }) => ({ filled: true, value }),
  }, { token: relay.token, adapter: false });
  try { return await fn({ relay, client, seen }); } finally { agent.close(); await relay.close(); await settle(); }
}

const allBlobText = (bundle) => Object.values(bundle.blobs).join('\n');

test('a redacted key never appears in any blob of an exported bundle: storage, cookie, IndexedDB field', async () => {
  await withAgent({ redactKeys: ['api_token', 'CSRF', 'sid', 'password'] }, async ({ client }) => {
    const sid = await client.startSession({});
    await client.cmd('dom.click', { selector: '#plain' });
    await client.endSession(sid);
    const bundle = await client.bundle(sid);
    const text = allBlobText(bundle);
    for (const s of [SECRET, COOKIE, DBPASS, 'csrf-SECRET']) assert.ok(!text.includes(s), `${s} must not be in any blob`);
    assert.ok(text.includes(REDACTED), 'the value is replaced, not dropped silently');
    assert.ok(text.includes('dark') && text.includes('alice'), 'unrelated data is kept');
    const cp = (await client.events(sid)).filter((e) => e.kind === 'checkpoint');
    assert.ok(cp.length >= 2);
    assert.equal(cp[0].data.coverage.redacted, 4, 'one value per redacted name is counted');
  });
});

test('control: without redactKeys the same secrets ARE in the bundle (so the test above can fail)', async () => {
  await withAgent({}, async ({ client }) => {
    const sid = await client.startSession({});
    await client.endSession(sid);
    const text = allBlobText(await client.bundle(sid));
    for (const s of [SECRET, COOKIE, DBPASS]) assert.ok(text.includes(s));
    assert.equal((await client.events(sid)).find((e) => e.kind === 'checkpoint').data.coverage.redacted, 0);
  });
});

test('redaction is applied at storage only: an effect check on the live capture still sees the real value', async () => {
  let saw = null;
  const profile = { redactKeys: ['api_token'], effectCheck: ({ after }) => { saw = after.page.localStorage.api_token; return { ok: true }; } };
  await withAgent(profile, async ({ client }) => {
    // irreversible so the effect check runs; the policy allows it
    const sid = await client.startSession({});
    await client.cmd('dom.click', { selector: '#go' });
    await client.endSession(sid);
    assert.equal(saw, SECRET, 'the check ran on the real world');
    assert.ok(!allBlobText(await client.bundle(sid)).includes(SECRET), 'and the stored world is redacted');
  });
});

test('every checkpoint records what the snapshot holds and what it cannot (HttpOnly cookies, worker caches, ...)', async () => {
  await withAgent({}, async ({ client }) => {
    const sid = await client.startSession({});
    await client.endSession(sid);
    const cov = (await client.events(sid)).find((e) => e.kind === 'checkpoint').data.coverage;
    assert.deepEqual(cov.captured, ['localStorage', 'sessionStorage', 'cookies', 'serviceWorkers', 'indexedDB']);
    assert.match(cov.notCaptured.join('|'), /HttpOnly/);
  });
});

test('a malformed redactKeys fails closed: the relay refuses to start', async () => {
  for (const bad of ['api_token', [''], [1], [null]]) await assert.rejects(createRelay({ port: 0, profile: { redactKeys: bad } }), /redactKeys/, JSON.stringify(bad));
});

test('redactWorld: case-insensitive, any depth, and does not touch what it was not asked to', () => {
  const w = { page: { a: { Token: 't', list: [{ TOKEN: 'u', keep: 1 }] } }, server: { keep: 2 } };
  const r = redactWorld(w, ['token']);
  assert.deepEqual(r.world, { page: { a: { Token: REDACTED, list: [{ TOKEN: REDACTED, keep: 1 }] } }, server: { keep: 2 } });
  assert.equal(r.count, 2);
  assert.deepEqual(w.page.a.Token, 't', 'the input is not mutated');
  assert.deepEqual(validateRedactKeys(undefined), []);
});
