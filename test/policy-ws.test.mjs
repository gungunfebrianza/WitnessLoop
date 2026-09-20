import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, validatePolicy, matches } from '../src/policy.mjs';
import { encodeFrame, decodeFrame } from '../src/ws.mjs';
import { COMMANDS, classify, publicTypes, timeoutFor } from '../src/registry.mjs';

test('policy: first matching rule wins, else default', () => {
  const p = {
    default: 'deny',
    rules: [
      { when: { 'preview.amount': { lte: 100 }, 'preview.to': { in: ['alice', 'bob'] } }, then: 'allow', reason: 'small to known' },
      { when: { 'preview.amount': { gt: 1000 } }, then: 'deny', reason: 'too big' },
      { when: { effect: 'irreversible' }, then: 'require_approval' },
    ],
  };
  assert.deepEqual(evaluate(p, { effect: 'irreversible', preview: { amount: '50', to: 'bob' } }), { verdict: 'allow', rule: 0, reason: 'small to known' });
  assert.equal(evaluate(p, { effect: 'irreversible', preview: { amount: '5000', to: 'bob' } }).verdict, 'deny');
  assert.equal(evaluate(p, { effect: 'irreversible', preview: { amount: '500', to: 'bob' } }).verdict, 'require_approval');
  assert.equal(evaluate(p, { effect: 'read' }).verdict, 'deny');
  assert.equal(evaluate(null, {}).verdict, 'require_approval');
});

test('policy operators', () => {
  assert.ok(matches({ matches: '^a.*z$' }, 'abcz'));
  assert.ok(matches({ exists: true }, 0));
  assert.ok(matches({ exists: false }, undefined));
  assert.ok(matches({ nin: ['x'] }, 'y'));
  assert.ok(matches({ gte: 5, lt: 10 }, '7'));
  assert.ok(!matches({ gte: 5, lt: 10 }, 'abc'));
  assert.ok(matches('bob', 'bob'));
});

test('policy validation rejects unknown verdicts and operators', () => {
  assert.throws(() => validatePolicy({ default: 'maybe' }), /policy.default/);
  assert.throws(() => validatePolicy({ rules: [{ then: 'nope' }] }), /then/);
  assert.throws(() => validatePolicy({ rules: [{ when: { a: { bogus: 1 } }, then: 'allow' }] }), /unknown policy operator/);
  assert.doesNotThrow(() => validatePolicy({ default: 'allow', rules: [] }));
});

function mask(frame) {
  // client frames are masked: rebuild an encodeFrame() output with a mask
  const opcode = frame[0] & 0x0f;
  let off = 2;
  let len = frame[1] & 0x7f;
  if (len === 126) { len = frame.readUInt16BE(2); off = 4; } else if (len === 127) { len = Number(frame.readBigUInt64BE(2)); off = 10; }
  const payload = frame.subarray(off, off + len);
  const m = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload.map((b, i) => b ^ m[i & 3]));
  const head = frame.subarray(0, off);
  const h = Buffer.from(head);
  h[1] |= 0x80;
  return Buffer.concat([h, m, masked]);
}

test('ws codec round-trips small, 16-bit and 64-bit length frames, masked or not', () => {
  for (const size of [0, 5, 125, 126, 70000]) {
    const payload = Buffer.alloc(size, 'a');
    const f = encodeFrame(0x1, payload);
    const plain = decodeFrame(f);
    assert.equal(plain.payload.length, size);
    assert.equal(plain.consumed, f.length);
    const masked = decodeFrame(mask(f));
    assert.deepEqual(masked.payload, payload);
  }
});

test('ws decodeFrame waits for a complete frame', () => {
  const f = mask(encodeFrame(0x1, Buffer.from('hello world')));
  assert.equal(decodeFrame(f.subarray(0, 3)), null);
  assert.equal(decodeFrame(f.subarray(0, f.length - 1)), null);
  const two = Buffer.concat([f, f]);
  const first = decodeFrame(two);
  assert.equal(first.payload.toString(), 'hello world');
  assert.equal(decodeFrame(two.subarray(first.consumed)).payload.toString(), 'hello world');
});

test('registry: dynamic clicks classify from the page annotation, internals are hidden', () => {
  assert.equal(classify('dom.query'), 'read');
  assert.equal(classify('dom.click', { effect: 'irreversible' }), 'irreversible');
  assert.equal(classify('dom.click', { effect: 'read' }), 'reversible', 'a page cannot downgrade a click to read');
  assert.equal(classify('dom.click', null), 'reversible');
  assert.equal(classify('nope'), null);
  assert.ok(!publicTypes().includes('world.restore'));
  assert.ok(!('eval' in COMMANDS), 'no eval: an unbounded write cannot be gated');
  assert.ok(timeoutFor('dom.wait', { timeoutMs: 1000 }) > 1000);
});
