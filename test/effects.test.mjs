// 2.4: the bank and mailer profiles are rebuilt on src/effects.mjs. The pre-refactor functions are kept below, verbatim,
// as the reference: the library-built ones must return exactly what they returned, `why` and `evidence` included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { conserved, deltaEquals, noExtraMembers, sameMembers, noExtraFields, forbid, allOf } from '../src/effects.mjs';
import { profile as bank } from '../examples/bank/profile.mjs';
import { profile as mailer } from '../examples/mailer/profile.mjs';
import { INITIAL_TOTAL, totalMoney, initialState as bankState, transfer } from '../examples/bank/model.mjs';
import { recipients, initialState as mailState, send } from '../examples/mailer/model.mjs';

// ---- reference copies of the code the profiles used to contain ----
const legacyBank = {
  invariant: (world) => {
    const total = totalMoney(world.server);
    return total === INITIAL_TOTAL ? { ok: true } : { ok: false, why: `money not conserved: total ${total} != ${INITIAL_TOTAL} (${total - INITIAL_TOTAL} cents)` };
  },
  effectCheck: ({ preview, before, after }) => {
    const moved = after.server.balances[preview.to] - before.server.balances[preview.to];
    const promised = Math.round(Number(preview.amount) * 100);
    return moved === promised ? { ok: true } : { ok: false, why: `${preview.to} received ${moved} cents but the preview promised ${promised}` };
  },
};
const legacyMailer = {
  invariant: (world) => {
    const bad = world.server.outbox.find((m) => recipients(m).some((r) => !r.endsWith('@acme.test')));
    return bad ? { ok: false, why: `message #${bad.id} "${bad.subject}" was delivered to ${recipients(bad).filter((r) => !r.endsWith('@acme.test')).join(', ')}` } : { ok: true };
  },
  effectCheck: ({ preview, after, before }) => {
    const fresh = after.server.outbox.slice(before.server.outbox.length);
    const extra = fresh.flatMap(recipients).filter((r) => r !== preview.to);
    return extra.length ? { ok: false, why: `delivered to ${extra.join(', ')} which the preview (to ${preview.to}) did not show`, evidence: fresh } : { ok: true };
  },
};

const clone = (x) => JSON.parse(JSON.stringify(x));
const bankWorld = (state) => ({ server: clone(state) });
function bankCase(amount, preview) {
  const s = bankState();
  const before = bankWorld(s);
  transfer(s, { from: 'alice', to: 'bob', amount }, 1);
  return { preview: preview ?? { to: 'bob', amount: String(amount) }, before, after: bankWorld(s) };
}

test('bank: invariant and effectCheck give exactly the answers they gave before, over honest, leaking and degenerate worlds', () => {
  const worlds = [bankWorld(bankState())];
  for (const amount of ['100', '1.00', '33.33', '0.01', '999.99']) { const s = bankState(); transfer(s, { to: 'bob', amount }, 1); worlds.push(bankWorld(s)); }
  const broken = bankState(); broken.fees += 7; worlds.push(bankWorld(broken));
  assert.ok(worlds.some((w) => legacyBank.invariant(w).ok === false) && worlds.some((w) => legacyBank.invariant(w).ok === true), 'the table has both outcomes');
  for (const w of worlds) assert.deepEqual(bank.invariant(w), legacyBank.invariant(w));

  const cases = [
    bankCase('100'), bankCase('1.00'), bankCase('33.33'),
    bankCase('100', { to: 'bob', amount: '250' }), // page promised something else
    bankCase('100', { to: 'bob', amount: 'lots' }), // unparsable promise
    bankCase('100', { to: 'nobody', amount: '100' }), // unknown account
  ];
  for (const c of cases) assert.deepEqual(bank.effectCheck(c), legacyBank.effectCheck(c), JSON.stringify(c.preview));
  assert.ok(cases.some((c) => bank.effectCheck(c).ok === false) && cases.some((c) => bank.effectCheck(c).ok === true));
});

test('mailer: invariant and effectCheck give exactly the answers (and evidence) they gave before', () => {
  const s = mailState();
  const before = clone({ server: s });
  send(s, { to: 'priya@acme.test', subject: 'Weekly status' }, 1);
  const afterHonest = clone({ server: s });
  send(s, { to: 'dana@acme.test', subject: 'Invoice 42 attached' }, 1); // planted hidden bcc
  const afterLeak = clone({ server: s });
  send(s, { to: 'sam.leigh@rival.example', subject: 'Contract' }, 1);
  const afterOutside = clone({ server: s });

  for (const w of [before, afterHonest, afterLeak, afterOutside]) assert.deepEqual(mailer.invariant(w), legacyMailer.invariant(w));
  const cases = [
    { preview: { to: 'priya@acme.test' }, before, after: afterHonest },
    { preview: { to: 'dana@acme.test' }, before: afterHonest, after: afterLeak },
    { preview: { to: 'someone@acme.test' }, before: afterHonest, after: afterLeak },
    { preview: { to: 'x@acme.test' }, before, after: before }, // nothing delivered
  ];
  for (const c of cases) assert.deepEqual(mailer.effectCheck(c), legacyMailer.effectCheck(c));
  const leak = mailer.effectCheck(cases[1]);
  assert.equal(leak.ok, false);
  assert.match(leak.why, /delivered to audit@evil\.example which the preview \(to dana@acme\.test\) did not show/);
  assert.equal(leak.evidence.length, 1, 'the evidence is the fresh messages');
});

// ---- the library itself: fail closed ----
test('conserved / deltaEquals: a value that is not a finite number never passes', () => {
  const c = conserved({ total: (w) => w.n, expected: 10, why: ({ total }) => `total ${total}` });
  assert.deepEqual(c({ n: 10 }), { ok: true });
  assert.deepEqual(c({ n: 9 }), { ok: false, why: 'total 9' });
  for (const bad of [NaN, undefined, '10', Infinity, null]) assert.equal(c({ n: bad }).ok, false, `${bad} must fail`);
  assert.equal(conserved({ total: () => 10, expected: NaN, why: () => 'no' })({}).ok, false, 'an expected value that is NaN fails too');

  const d = deltaEquals({ read: (w) => w.v, promised: ({ p }) => p, why: ({ moved, promised }) => `${moved} vs ${promised}` });
  assert.equal(d({ before: { v: 1 }, after: { v: 6 }, p: 5 }).ok, true);
  assert.equal(d({ before: { v: 1 }, after: { v: 6 }, p: 4 }).why, '5 vs 4');
  assert.equal(d({ before: { v: 1 }, after: {}, p: 5 }).ok, false, 'a missing reading fails');
  assert.equal(d({ before: { v: 1 }, after: { v: 1 }, p: NaN }).ok, false, 'an unparsable promise fails, even though NaN moved nothing');
});

test('a check that throws is a failure with a reason, not a pass and not a crash', () => {
  const boom = deltaEquals({ read: (w) => w.x.y, promised: () => 1, why: () => 'w' });
  const r = boom({ before: {}, after: {} });
  assert.equal(r.ok, false);
  assert.match(r.why, /check could not run/);
  const noPreview = bank.effectCheck({ preview: null, before: bankWorld(bankState()), after: bankWorld(bankState()) });
  assert.equal(noPreview.ok, false, 'no preview to compare with: fail closed');
});

test('noExtraMembers / sameMembers / noExtraFields / forbid / allOf', () => {
  const extra = noExtraMembers({ actual: (c) => c.got, allowed: (c) => c.want, why: ({ extra }) => `extra ${extra}` });
  assert.equal(extra({ got: ['a'], want: ['a', 'b'] }).ok, true, 'a subset is fine for noExtraMembers');
  assert.equal(extra({ got: ['a', 'z'], want: ['a'] }).why, 'extra z');
  assert.equal(extra({ got: [1], want: ['1'] }).ok, true, 'compared as strings');

  const same = sameMembers({ actual: (c) => c.got, expected: (c) => c.want, why: ({ extra, missing }) => `+${extra} -${missing}` });
  assert.equal(same({ got: ['a', 'b'], want: ['b', 'a'] }).ok, true);
  assert.equal(same({ got: ['a'], want: ['a', 'b'] }).why, '+ -b', 'a promised recipient that never got it is a failure here');
  assert.equal(same({ got: ['a', 'c'], want: ['a'] }).why, '+c -');

  const fields = noExtraFields({ actual: (c) => c.rec, allowed: () => ['to', 'amount'], why: ({ extra }) => `fields ${extra}` });
  assert.equal(fields({ rec: { to: 'b', amount: 1 } }).ok, true);
  assert.equal(fields({ rec: { to: 'b', amount: 1, bcc: 'x' } }).why, 'fields bcc');
  assert.equal(fields({ rec: null }).ok, false, 'no record to inspect fails closed');

  const none = forbid({ find: (c) => c.list.find((x) => x < 0), why: (bad) => `negative ${bad}` });
  assert.equal(none({ list: [1, 2] }).ok, true);
  assert.equal(none({ list: [1, -3] }).why, 'negative -3');

  const ok = () => ({ ok: true });
  const no = () => ({ ok: false, why: 'first' });
  assert.equal(allOf(ok, ok)({}).ok, true);
  assert.equal(allOf(ok, no, () => ({ ok: false, why: 'second' }))({}).why, 'first', 'first failure wins');
  assert.equal(allOf(ok, () => undefined)({}).ok, false, 'a check that returns nothing is not a pass');
  assert.equal(allOf(ok, () => ({ ok: 'yes' }))({}).ok, false, 'only a literal true passes');
  assert.equal(allOf()({}).ok, true, 'no checks, nothing to fail');
});
