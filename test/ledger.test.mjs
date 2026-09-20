import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canon, hashOf, stripKeys, getPath, setPath } from '../src/canon.mjs';
import { generateKey, fingerprint, signMessage, verifySignature } from '../src/attest.mjs';
import { Ledger, verifyBundle, eventHash, GENESIS } from '../src/ledger.mjs';

const clone = (x) => JSON.parse(JSON.stringify(x));

function seeded(n = 4, opts = {}) {
  const key = generateKey();
  const l = new Ledger(':memory:', { key, ...opts });
  const sid = l.startSession({ goal: 'demo', actor: 'tester' });
  for (let i = 0; i < n; i++) l.append(sid, { kind: 'command', type: 'dom.click', effect: 'reversible', ok: true, data: { params: { i }, result: { done: i } } });
  l.endSession(sid, { note: 'bye' });
  return { l, sid, key };
}

test('canon is key-order independent and drops undefined', () => {
  assert.equal(canon({ b: 1, a: [2, { d: 1, c: undefined }] }), canon({ a: [2, { d: 1 }], b: 1 }));
  assert.equal(hashOf({ x: 1, y: 2 }), hashOf({ y: 2, x: 1 }));
  assert.notEqual(hashOf({ x: 1 }), hashOf({ x: 2 }));
});

test('stripKeys removes volatile keys at any depth; getPath/setPath round-trip', () => {
  assert.deepEqual(stripKeys({ ts: 1, a: { ts: 2, b: 3 }, l: [{ ts: 9, k: 1 }] }, ['ts']), { a: { b: 3 }, l: [{ k: 1 }] });
  const o = {};
  setPath(o, 'a.b.c', 5);
  assert.equal(getPath(o, 'a.b.c'), 5);
  assert.equal(getPath(o, 'a.x.c'), undefined);
});

test('signatures verify and reject a wrong key or message', () => {
  const a = generateKey();
  const b = generateKey();
  const sig = signMessage(a.privateKey, 'hello');
  assert.ok(verifySignature(a.publicKey, 'hello', sig));
  assert.ok(!verifySignature(a.publicKey, 'hellO', sig));
  assert.ok(!verifySignature(b.publicKey, 'hello', sig));
  assert.notEqual(fingerprint(a.publicKey), fingerprint(b.publicKey));
});

test('a fresh chain verifies, is linked from genesis, and ends sealed', () => {
  const { l, sid } = seeded();
  const ev = l.events(sid);
  assert.equal(ev[0].prev_hash, GENESIS);
  ev.slice(1).forEach((e, i) => assert.equal(e.prev_hash, ev[i].hash));
  const r = l.verifySessionId(sid, { strict: true });
  assert.ok(r.ok, JSON.stringify(r.problems));
  assert.equal(r.checked, ev.length);
  assert.equal(r.sealedThrough, ev.length - 1);
  assert.equal(r.ended, true);
});

test('editing an event field is caught at exactly that event', () => {
  const { l, sid } = seeded();
  l.db.prepare('UPDATE events SET ok = 0 WHERE session_id = ? AND idx = 3').run(sid);
  const r = l.verifySessionId(sid);
  assert.equal(r.ok, false);
  assert.equal(r.badIdx, 3);
});

test('editing a payload blob is caught (the event still points at the old hash)', () => {
  const { l, sid } = seeded();
  const target = l.events(sid)[2];
  l.db.prepare('UPDATE blobs SET json = ? WHERE hash = ?').run('{"params":{"i":99},"result":{"done":99}}', target.data_hash);
  const r = l.verifySessionId(sid);
  assert.equal(r.ok, false);
  assert.equal(r.badIdx, 2);
  assert.match(r.problems[0].reason, /blob/);
});

test('deleting a middle event is caught as a gap', () => {
  const { l, sid } = seeded();
  l.db.prepare('DELETE FROM events WHERE session_id = ? AND idx = 2').run(sid);
  const r = l.verifySessionId(sid);
  assert.equal(r.ok, false);
  assert.equal(r.badIdx, 2);
});

test('swapping two events breaks the chain', () => {
  const { l, sid } = seeded();
  const b = clone(l.bundle(sid));
  [b.events[1], b.events[2]] = [b.events[2], b.events[1]];
  const r = verifyBundle(b);
  assert.equal(r.ok, false);
  assert.equal(r.badIdx, 1);
});

test('truncating the tail is caught by the seal (and strict mode)', () => {
  const { l, sid } = seeded();
  const b = clone(l.bundle(sid));
  b.events.pop();
  b.events.pop();
  const r = verifyBundle(b);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /truncated|session.end/.test(p.reason)));
});

test('a forged seal signed by another key fails against a pinned trusted key', () => {
  const { l, sid, key } = seeded();
  const b = clone(l.bundle(sid));
  assert.ok(verifyBundle(b, { trustedKey: fingerprint(key.publicKey) }).ok);
  const other = generateKey();
  const forged = clone(b);
  forged.seals = forged.seals.map((s) => ({ ...s, pubkey: other.publicKey }));
  assert.equal(verifyBundle(forged).ok, false, 'signature no longer matches the swapped key');
  assert.equal(verifyBundle(b, { trustedKey: fingerprint(other.publicKey) }).ok, false, 'valid chain, wrong signer');
});

test('rewriting an event AND recomputing every later hash still fails the seal', () => {
  const { l, sid } = seeded();
  const b = clone(l.bundle(sid));
  b.events[1].type = 'evil';
  let p = b.events[0].hash;
  for (let i = 1; i < b.events.length; i++) {
    b.events[i].prev_hash = p;
    b.events[i].hash = eventHash(p, b.events[i]);
    p = b.events[i].hash;
  }
  const r = verifyBundle(b);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((x) => /seal head hash/.test(x.reason)), 'seal pins the original head');
});

test('bundle verifies with no database and carries every referenced blob', () => {
  const { l, sid } = seeded(6);
  const b = JSON.parse(JSON.stringify(l.bundle(sid)));
  assert.equal(b.format, 'witnessloop.bundle/1');
  assert.ok(verifyBundle(b).ok);
  for (const e of b.events) if (e.data_hash) assert.ok(b.blobs[e.data_hash] !== undefined);
  delete b.blobs[b.events[3].data_hash];
  assert.equal(verifyBundle(b).badIdx, 3);
});

test('periodic seals are written while the session runs', () => {
  const key = generateKey();
  const l = new Ledger(':memory:', { key, sealEvery: 3 });
  const sid = l.startSession({ goal: 'x' });
  for (let i = 0; i < 7; i++) l.append(sid, { kind: 'command', data: { i } });
  assert.ok(l.seals(sid).length >= 2);
  assert.ok(l.verifySessionId(sid).ok);
});

test('a fork anchor must match the parent chain', () => {
  const key = generateKey();
  const l = new Ledger(':memory:', { key });
  const parent = l.startSession({ goal: 'parent' });
  const e1 = l.append(parent, { kind: 'command', data: { a: 1 } });
  const fork = l.startSession({ goal: 'fork', parent });
  l.append(fork, { kind: 'fork.start', data: { parent_session: parent, parent_head_idx: e1.idx, parent_head_hash: e1.hash } });
  assert.ok(l.verifySessionId(fork).ok);
  const bad = l.startSession({ goal: 'lying fork', parent });
  l.append(bad, { kind: 'fork.start', data: { parent_session: parent, parent_head_idx: e1.idx, parent_head_hash: 'f'.repeat(64) } });
  const r = l.verifySessionId(bad);
  assert.equal(r.ok, false);
  assert.match(r.problems[0].reason, /fork anchor/);
});

test('cannot end a session twice or append to a missing session', () => {
  const { l, sid } = seeded();
  assert.throws(() => l.endSession(sid), /already ended/);
  assert.throws(() => l.append(999, { kind: 'x' }), /no such session/);
});
