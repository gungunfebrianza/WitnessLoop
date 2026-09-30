// 3.5: every divergence gets a class and the evidence for it; nothing is "ok" unless it sits inside a declared volatile key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDivergences, classCounts, allVolatile, CLASSES } from '../src/classify.mjs';

const step = (over = {}) => ({ position: 0, parentIdx: 7, denied: false, failed: false, paths: [], volatilePaths: [], ...over });
const run = (over = {}) => buildDivergences({ volatileKeys: ['created'], ...over });

test('nothing differs: no divergences at all', () => {
  assert.deepEqual(run({ steps: [step()] }), []);
  assert.deepEqual(classCounts([]), { volatile: 0, nondeterministic: 0, external: 0, unknown: 0 });
  assert.deepEqual(CLASSES, ['volatile', 'nondeterministic', 'external', 'unknown']);
});

test('volatile: a difference wholly inside a declared volatile key is reported, labelled volatile, and is the only thing that is ok', () => {
  const d = run({ steps: [step({ volatilePaths: ['result.rows.0.created'] })], final: { paths: [], volatilePaths: ['indexedDB.db.stores.t.rows.0.value.created'] } });
  assert.equal(d.length, 2, 'reported, not swallowed');
  assert.ok(d.every((x) => x.class === 'volatile' && x.ok === true));
  assert.match(d[0].evidence[0].what, /only declared volatile keys differ \(created\)/);
  assert.equal(allVolatile(['a.created'], ['created']), true);
  assert.equal(allVolatile(['a.created', 'a.total'], ['created']), false, 'one path outside the key breaks it');
  assert.equal(allVolatile([], ['created']), false, 'nothing to vouch for is not volatile');
});

test('a raw difference outside any declared key is never "ok", even if it arrives on the volatile path list', () => {
  const d = run({ steps: [step({ volatilePaths: ['result.total'] })], final: { paths: [], volatilePaths: ['server.balance'] } });
  assert.ok(d.every((x) => x.ok === false && x.class === 'unknown'));
});

test('nondeterministic: the shadow page drew clock or random values the recording did not hold (and the reverse)', () => {
  const d = run({ steps: [step({ paths: ['result.value'], nondet: { used: { now: 2, random: 1 }, fed: { now: 0, random: 0 } } })] });
  assert.equal(d[0].class, 'nondeterministic');
  assert.equal(d[0].ok, false);
  assert.deepEqual(d[0].evidence.map((e) => e.what), [
    'the page drew 2 clock value(s) (Date.now / new Date) that the recording did not hold (step at #7)',
    'the page drew 1 Math.random value(s) that the recording did not hold (step at #7)',
  ]);
  const fewer = run({ steps: [step({ paths: ['x'], nondet: { used: { now: 1, random: 0 }, fed: { now: 3, random: 0 } } })] });
  assert.match(fewer[0].evidence[0].what, /drew 1 clock value\(s\).*where the recording holds 3/);
  assert.equal(run({ steps: [step({ paths: ['x'], nondet: { used: { now: 1, random: 1 }, fed: { now: 1, random: 1 } } })] })[0].class, 'unknown', 'drawing exactly what was fed explains nothing');
});

test('nondeterministic: an IndexedDB key generator that did not come back, tied to the store the difference is in', () => {
  const drift = [{ db: 'app', store: 'items', expected: 4, actual: 3 }];
  const r = run({ restore: { verified: false, drift } });
  assert.equal(r[0].where, 'restore');
  assert.equal(r[0].class, 'nondeterministic');
  assert.match(r[0].evidence[0].what, /IndexedDB app\/items: the autoIncrement key generator is at 3 after restore, not the recorded 4/);
  const f = run({ restore: { verified: true, drift }, final: { paths: ['indexedDB.app.stores.items.rows.2.key'], volatilePaths: [] } });
  assert.equal(f[0].class, 'nondeterministic', 'the difference is inside the drifted store');
  const other = run({ restore: { verified: true, drift }, final: { paths: ['indexedDB.app.stores.other.rows.0'], volatilePaths: [] } });
  assert.equal(other[0].class, 'unknown', 'a difference in a store that did not drift is not blamed on the drift');
});

test('external: a call with no recorded response, or a recorded step that reached a foreign origin nobody recorded', () => {
  const missed = run({ steps: [step({ paths: ['ok'], external: { served: 0, missed: [{ method: 'GET', origin: 'https://api.x', path: '/q', reason: 'no recorded response' }] } })] });
  assert.equal(missed[0].class, 'external');
  assert.match(missed[0].evidence[0].what, /no recorded response for GET https:\/\/api\.x\/q \(no recorded response\) \(step at #7\)/);
  const foreign = [{ method: 'POST', origin: 'https://pay.example', path: '/charge' }];
  const unrecorded = run({ parentOrigin: 'http://127.0.0.1:3000', steps: [step({ paths: ['result.x'], parentObserved: foreign })] });
  assert.equal(unrecorded[0].class, 'external');
  assert.match(unrecorded[0].evidence[0].what, /sent POST https:\/\/pay\.example\/charge to a foreign origin whose response was not recorded/);
  assert.equal(run({ parentOrigin: 'http://127.0.0.1:3000', externalMode: 'recorded', steps: [step({ paths: ['x'], parentObserved: foreign })] })[0].class, 'unknown', 'when responses ARE recorded that is not evidence of a miss');
  const own = [{ method: 'POST', origin: 'http://127.0.0.1:3000', path: '/api' }, { method: 'GET', origin: 'https://cdn.x', path: '/a' }];
  assert.equal(run({ parentOrigin: 'http://127.0.0.1:3000', steps: [step({ paths: ['x'], parentObserved: own })] })[0].class, 'unknown', 'own origin and safe methods are not external evidence');
});

test('external outranks nondeterministic when both are present, and both pieces of evidence are kept', () => {
  const d = run({ steps: [step({ paths: ['x'], nondet: { used: { now: 1, random: 0 }, fed: { now: 0, random: 0 } }, external: { served: 0, missed: [{ method: 'GET', origin: 'o', path: '/p', reason: 'r' }] } })] });
  assert.equal(d[0].class, 'external');
  assert.deepEqual(d[0].evidence.map((e) => e.class).sort(), ['external', 'nondeterministic']);
});

test('unknown: a difference nothing explains says so, and is not ok', () => {
  const d = run({ steps: [step({ paths: ['result.total'] })], final: { paths: ['server.balance'], volatilePaths: [] } });
  assert.deepEqual(d.map((x) => [x.where, x.class, x.ok]), [['step', 'unknown', false], ['final', 'unknown', false]]);
  assert.match(d[0].evidence[0].what, /nothing recorded explains it/);
  assert.deepEqual(d[0].paths, ['result.total']);
});

test('a refused or failed replayed step, and a missing final checkpoint, are divergences too', () => {
  const d = run({ steps: [step({ denied: true }), step({ position: 1, parentIdx: 9, failed: true, error: 'agent gone' })], final: { paths: [], volatilePaths: [], missing: true } });
  assert.deepEqual(d.map((x) => x.class), ['unknown', 'unknown', 'unknown']);
  assert.match(d[0].evidence[0].what, /refused by the gate/);
  assert.match(d[1].evidence[0].what, /failed: agent gone/);
  assert.match(d[2].evidence[0].what, /no final checkpoint/);
  assert.ok(d.every((x) => !x.ok));
});

test('an unverified restore with nothing to explain it is unknown, not ok', () => {
  const d = run({ restore: { verified: false, drift: [] } });
  assert.equal(d[0].class, 'unknown');
  assert.equal(d[0].ok, false);
});

test('classCounts tallies every class, including the empty ones', () => {
  const d = run({ steps: [step({ volatilePaths: ['created'] }), step({ position: 1, paths: ['a'] })] });
  assert.deepEqual(classCounts(d), { volatile: 1, nondeterministic: 0, external: 0, unknown: 1 });
});
