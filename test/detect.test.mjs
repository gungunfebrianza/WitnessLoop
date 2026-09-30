// 2.1: offline detection of reversible clicks whose recorded consequences look external. After the fact, never prevention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRelay } from '../src/relay.mjs';
import { createClient } from '../src/client.mjs';
import { detectUnannotated, AFTER_THE_FACT } from '../src/detect.mjs';
import { buildReport } from '../src/report.mjs';
import { handleWitnessRequest } from '../src/adapter.mjs';
import { connectFakeAgent } from './helpers/fake-agent.mjs';

const settle = () => new Promise((r) => setTimeout(r, 100)); // let sockets finish closing: on Windows a forced exit (--test-force-exit) racing them aborts libuv

// ---- pure: hand-built events and world blobs ----
const cp = (idx, hash, after_idx = null) => ({ idx, kind: 'checkpoint', data: { world_hash: hash, after_idx } });
const click = (idx, over = {}) => ({ idx, kind: 'command', type: 'dom.click', effect: 'reversible', ok: true, data: { params: { selector: '#pay' }, result: { clicked: true }, ...over } });
const world = (server, page = {}) => ({ page: { localStorage: page, indexedDB: {} }, server });
const blobs = { w1: world({ balance: 100 }), w2: world({ balance: 60 }), p1: world(null, { a: '1' }), p2: world(null, { a: '2' }), same: world({ balance: 100 }) };
const run = (events) => detectUnannotated({ events, getBlob: (h) => blobs[h] });

test('a reversible click that changed server state is detected; the report says it is after the fact', () => {
  const events = [cp(1, 'w1'), click(2), cp(3, 'w2', 2)];
  const r = run(events);
  assert.equal(r.detections.length, 1);
  assert.equal(r.detections[0].kind, 'server_state_changed');
  assert.deepEqual(r.detections[0].paths, ['balance']);
  assert.equal(r.detections[0].confidence, 'heuristic');
  assert.equal(r.note, AFTER_THE_FACT);
  const md = buildReport({ session: { id: 1, actor: 'a', agent: 'default', status: 'ended' }, events: [{ idx: 0, kind: 'session.start', data: {} }, ...events], verify: { ok: true, checked: 1, sealedThrough: 1, signers: [] }, detections: r });
  assert.match(md, /## Detected after the fact/);
  assert.match(md, /not prevention/);
  assert.match(md, /changed server state \(balance\)/);
});

test('what is NOT detected: page-only storage changes, unchanged server state, irreversible clicks, failed clicks', () => {
  assert.equal(run([cp(1, 'p1'), click(2), cp(3, 'p2', 2)]).detections.length, 0, 'localStorage is what reversible means');
  assert.equal(run([cp(1, 'w1'), click(2), cp(3, 'same', 2)]).detections.length, 0);
  assert.equal(run([cp(1, 'w1'), { ...click(2), effect: 'irreversible' }, cp(3, 'w2', 2)]).detections.length, 0, 'the gate already saw it');
  assert.equal(run([cp(1, 'w1'), { ...click(2), ok: false }, cp(3, 'w2', 2)]).detections.length, 0);
});

test('a click that cannot be checked is reported as skipped, never as clean', () => {
  const noPost = run([cp(1, 'w1'), click(2)]);
  assert.equal(noPost.detections.length, 0);
  assert.equal(noPost.skipped[0].command_idx, 2);
  assert.match(noPost.skipped[0].reason, /no checkpoint/);
  const noServer = run([cp(1, 'p1'), click(2), cp(3, 'p2', 2)]);
  assert.match(noServer.skipped[0].reason, /no server adapter/);
  const broken = detectUnannotated({ events: [cp(1, 'gone'), click(2), cp(3, 'w2', 2)], getBlob: () => { throw new Error('missing blob'); } });
  assert.match(broken.skipped[0].reason, /could not be read/);
  const md = buildReport({ session: { id: 1, actor: 'a', agent: 'x', status: 'ended' }, events: [{ idx: 0, kind: 'session.start', data: {} }], verify: { ok: true, checked: 1, sealedThrough: 1, signers: [] }, detections: noPost });
  assert.match(md, /not checkable: #2/);
});

test('a recorded non-GET request is detected even when no live flag was written, and is marked when it was', () => {
  const eff = [{ method: 'POST', origin: 'http://x', path: '/pay', body_hash: null }];
  const r = run([cp(1, 'same'), click(2, { result: { clicked: true, observed_effects: eff } }), cp(3, 'same', 2)]);
  assert.equal(r.detections[0].kind, 'observed_request');
  assert.equal(r.detections[0].also_flagged_live, false);
  const live = run([cp(1, 'same'), click(2, { result: { observed_effects: eff } }), { idx: 4, kind: 'flag', type: 'undeclared_effect', data: { command_idx: 2 } }, cp(5, 'same', 2)]);
  assert.equal(live.detections[0].also_flagged_live, true);
  assert.equal(run([cp(1, 'same'), click(2, { result: { observed_effects: [{ ...eff[0], method: 'GET' }] } }), cp(3, 'same', 2)]).detections.length, 0);
});

// ---- end to end through a real relay: an unannotated Pay button that debits the app server ----
test('relay: an unannotated Pay button that moves server state is found in the report and by `detect`', async () => {
  const state = { balance: 100 };
  const server = http.createServer((req, res) => { if (!handleWitnessRequest(req, res, { getState: () => state, setState: (s) => { Object.assign(state, s); } })) res.writeHead(404).end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const relay = await createRelay({ port: 0, policy: { default: 'require_approval', rules: [] }, approvalTimeoutMs: 500 });
  await relay.listen();
  const client = createClient({ port: relay.port, token: relay.token });
  const agent = await connectFakeAgent(relay.port, {
    'dom.describe': () => ({ effect: 'reversible', declared: null, label: 'Pay' }), // no data-wl-effect: the gate cannot know
    'dom.click': () => { state.balance -= 40; return { clicked: true, observed_effects: [{ method: 'POST', origin, path: '/api/pay', body_hash: null }] }; },
    'world.capture': () => ({ localStorage: {}, indexedDB: {} }),
  }, { origin, adapter: true, token: relay.token });
  try {
    const sid = await client.startSession({});
    const out = await client.cmd('dom.click', { selector: '#pay' });
    assert.equal(out.ok, true, 'it ran: nothing was held for approval');
    assert.equal(state.balance, 60, 'and the money moved');
    assert.equal((await client.events(sid)).filter((e) => e.kind === 'intent').length, 0, 'the gate never saw it');
    await client.endSession(sid);
    const d = await client.detect(sid);
    assert.equal(d.detections.length, 2, 'both the observed request and the server diff');
    assert.deepEqual(d.detections.map((x) => x.kind).sort(), ['observed_request', 'server_state_changed']);
    assert.ok(d.detections.every((x) => x.also_flagged_live));
    const { markdown } = await client.report(sid);
    assert.match(markdown, /Detected after the fact/);
    assert.match(markdown, /already flagged live/);
    assert.match(markdown, /undeclared network effect|undeclared_effect/);
  } finally { agent.close(); await relay.close(); server.closeAllConnections?.(); await new Promise((r) => server.close(r)); await settle(); }
});
