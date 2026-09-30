// 2.5: policy hardening: shadowed-rule warnings, a cap on `matches`, and a dry-run over a recorded session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, validatePolicy, lintPolicy, regexRisk, LIMITS } from '../src/policy.mjs';
import { findOp } from '../src/ops.mjs';
import { parseArgs } from '../src/cli.mjs';
import { withBank, transferVia } from './helpers/relay.mjs';

const rule = (when, then = 'allow') => ({ when, then });
const shadowed = (rules) => lintPolicy({ rules }).filter((w) => w.kind === 'shadowed').map((w) => [w.rule, w.by]);

test('a rule that can never match is warned about: empty earlier rule, tighter bound, subset of an `in`, identical condition', () => {
  assert.deepEqual(shadowed([rule({}), rule({ 'preview.to': 'bob' }, 'deny')]), [[1, 0]], 'a catch-all covers everything after it');
  assert.deepEqual(shadowed([rule({ 'preview.amount': { lte: 100 } }), rule({ 'preview.amount': { lte: 50 } }, 'deny')]), [[1, 0]], 'lte 50 implies lte 100');
  assert.deepEqual(shadowed([rule({ 'preview.amount': { lt: 100 } }), rule({ 'preview.amount': { lte: 99 } })]), [[1, 0]]);
  assert.deepEqual(shadowed([rule({ 'preview.amount': { gt: 10 } }), rule({ 'preview.amount': { gte: 11 } })]), [[1, 0]]);
  assert.deepEqual(shadowed([rule({ 'preview.to': { in: ['alice', 'bob', 'carol'] } }), rule({ 'preview.to': { in: ['bob', 'carol'] } }, 'deny')]), [[1, 0]]);
  assert.deepEqual(shadowed([rule({ 'preview.to': 'bob' }), rule({ 'preview.to': { in: ['bob'] } })]), [[1, 0]], 'eq and in are compared by meaning, not by spelling');
  assert.deepEqual(shadowed([rule({ 'preview.to': { in: ['alice', 'bob'] } }), rule({ 'preview.to': 'bob', 'preview.amount': { gt: 5 } })]), [[1, 0]], 'extra constraints on the later rule do not save it');
  const w = lintPolicy({ rules: [rule({}, 'allow'), rule({ x: 1 }, 'deny')] })[0];
  assert.equal(w.decidesDifferently, true);
  assert.match(w.message, /rule 1 can never match: rule 0 already matches everything it does and decides differently \(allow, not deny\)/);
});

test('no warning when rules merely overlap or the implication cannot be shown: a warning is never a guess', () => {
  assert.deepEqual(shadowed([rule({ 'preview.amount': { lte: 50 } }), rule({ 'preview.amount': { lte: 100 } }, 'deny')]), [], 'the later rule is wider, so it still matches some contexts');
  assert.deepEqual(shadowed([rule({ 'preview.to': 'bob' }), rule({ 'preview.amount': { gt: 1 } })]), [], 'a different field');
  assert.deepEqual(shadowed([rule({ 'preview.to': { in: ['bob'] } }), rule({ 'preview.to': { in: ['bob', 'carol'] } })]), []);
  assert.deepEqual(shadowed([rule({ 'preview.to': { matches: '^b' } }), rule({ 'preview.to': { matches: '^bo' } })]), [], 'regex containment is not provable here');
  assert.deepEqual(shadowed([rule({ 'preview.amount': { lt: 100 } }), rule({ 'preview.amount': { lte: 100 } })]), [], 'lte 100 includes 100, lt 100 does not');
  assert.deepEqual(shadowed([rule({ 'preview.amount': { ne: 5 } }), rule({ 'preview.amount': { ne: 6 } })]), []);
  assert.deepEqual(shadowed([]), []);
  assert.deepEqual(shadowed([rule({ 'preview.amount': { lte: 100 }, 'preview.to': 'bob' }), rule({ 'preview.amount': { lte: 50 } })]), [], 'the earlier rule needs a field the later one does not constrain');
});

test('a catastrophic `matches` is stopped: it cannot hold the relay, and it does not become a silent no-match', () => {
  const nasty = { default: 'allow', rules: [{ when: { 'preview.to': { matches: '^(a+)+$' } }, then: 'deny' }] };
  const ctx = { preview: { to: `${'a'.repeat(40)}!` } };
  const t0 = Date.now();
  const v = evaluate(nasty, ctx);
  assert.ok(Date.now() - t0 < 5000, `returned in ${Date.now() - t0}ms instead of hanging`);
  assert.equal(v.verdict, 'require_approval', 'unknown whether the deny rule applies: a human decides');
  assert.equal(v.limit, true);
  assert.match(v.reason, /regex limit exceeded in rule 0/);
  assert.equal(evaluate({ ...nasty, default: 'deny' }, ctx).verdict, 'deny', 'a policy that denies by default stays closed');
  assert.deepEqual(evaluate(nasty, { preview: { to: 'aaa' } }), { verdict: 'deny', rule: 0, reason: 'rule 0' }, 'a benign input is still evaluated normally');
  assert.equal(evaluate(nasty, { preview: { to: 'b' } }).verdict, 'allow');
  assert.ok(lintPolicy(nasty).some((x) => x.kind === 'regex' && /quantified group/.test(x.message)), 'and the lint says why');
});

test('matches limits: over-long input, over-long or malformed patterns', () => {
  const p = { default: 'allow', rules: [{ when: { note: { matches: '^x' } }, then: 'deny' }] };
  assert.equal(evaluate(p, { note: 'y'.repeat(LIMITS.regexInput + 1) }).limit, true, 'an input over the cap is not scanned');
  assert.equal(evaluate(p, { note: 'x'.repeat(LIMITS.regexInput) }).verdict, 'deny', 'at the cap it still is');
  assert.throws(() => validatePolicy({ rules: [{ when: { a: { matches: 'x'.repeat(LIMITS.regexSource + 1) } }, then: 'deny' }] }), /limit/);
  assert.throws(() => validatePolicy({ rules: [{ when: { a: { matches: '(' } }, then: 'deny' }] }), /does not compile/);
  assert.throws(() => validatePolicy({ rules: [{ when: { a: { matches: 5 } }, then: 'deny' }] }), /string pattern/);
  assert.doesNotThrow(() => validatePolicy({ rules: [{ when: { a: { matches: '^[a-z]+$' } }, then: 'deny' }] }));
});

test('regexRisk names the shapes it warns about and leaves ordinary patterns alone', () => {
  for (const bad of ['^(a+)+$', '(x*)*y', '(a|a)*', '(a|ab)+c', '.*foo.*bar']) assert.ok(regexRisk(bad), bad);
  for (const fine of ['^[a-z]+@acme\\.test$', '^bob$', '\\d{3}-\\d{4}', '^(alice|bob)$', 'foo.*']) assert.equal(regexRisk(fine), null, fine);
});

// ---- dry run over a recorded session ----
const RECORDED = { default: 'deny', rules: [{ when: { 'preview.amount': { lte: 100 }, 'preview.to': { in: ['bob'] } }, then: 'allow', reason: 'small to a known payee' }] };

test('policy --dry-run: what each recorded intent would have decided, read-only', async () => {
  await withBank(async ({ client }) => {
    const sid = await client.startSession({});
    await transferVia(client, 'bob', 50);
    await transferVia(client, 'bob', 500);
    await transferVia(client, 'carol', 20);
    await client.endSession(sid);
    const before = (await client.events(sid)).length;

    const same = await client.policyDryRun(sid);
    assert.equal(same.intents, 3);
    assert.equal(same.changed, 0, 'the policy that ran would decide the same');
    assert.deepEqual(same.rows.map((r) => [r.recorded.verdict, r.would.verdict]), [['allow', 'allow'], ['deny', 'deny'], ['deny', 'deny']]);
    assert.equal(same.rows[0].would.rule, 0);
    assert.equal(same.rows[0].preview.to, 'bob');

    const stricter = await client.policyDryRun(sid, { default: 'deny', rules: [] });
    assert.equal(stricter.changed, 1);
    assert.deepEqual(stricter.rows.filter((r) => r.changed).map((r) => r.preview.amount), ['50']);
    assert.equal(stricter.rows[0].would.verdict, 'deny');
    assert.equal(stricter.rows[0].recorded.verdict, 'allow', 'what really happened is still shown next to it');

    const looser = await client.policyDryRun(sid, { default: 'allow', rules: [] });
    assert.deepEqual(looser.rows.map((r) => r.would.verdict), ['allow', 'allow', 'allow']);

    assert.equal((await client.events(sid)).length, before, 'a dry run appends nothing');
    assert.ok((await client.verify(sid, true)).ok);
  }, { policy: RECORDED });
});

test('dry-run carries the lint warnings and fails loudly on a bad policy or session', async () => {
  await withBank(async ({ client }) => {
    const sid = await client.startSession({});
    await transferVia(client, 'bob', 50);
    await client.endSession(sid);
    const r = await client.policyDryRun(sid, { default: 'deny', rules: [{ when: {}, then: 'allow' }, { when: { 'preview.to': 'bob' }, then: 'deny' }, { when: { 'preview.to': { matches: '^(a+)+$' } }, then: 'deny' }] });
    assert.deepEqual(r.warnings.map((w) => w.kind).sort(), ['regex', 'shadowed', 'shadowed']);
    assert.equal(r.rows[0].would.verdict, 'allow');
    await assert.rejects(client.policyDryRun(sid, { default: 'sometimes' }), (e) => e.status === 400 && /policy is not valid/.test(e.message));
    await assert.rejects(client.policyDryRun(999, { default: 'deny' }), (e) => e.status === 404);
  }, { policy: RECORDED });
});

test('a hostile recorded preview cannot stall a dry run', async () => {
  await withBank(async ({ client }) => {
    const sid = await client.startSession({});
    await transferVia(client, 'bob', 50);
    await client.endSession(sid);
    const t0 = Date.now();
    const r = await client.policyDryRun(sid, { default: 'allow', rules: [{ when: { 'preview.to': { matches: '(x+x+)+y' } }, then: 'deny' }] });
    assert.ok(Date.now() - t0 < 3000);
    assert.equal(r.rows.length, 1);
  }, { policy: RECORDED });
});

test('CLI and MCP table: `policy --dry-run <session> [<file>]` parses, and plain `policy` is unchanged', () => {
  const op = findOp('policy');
  assert.deepEqual(parseArgs(op, ['--dry-run', '7']), { dryRun: '7' });
  assert.deepEqual(parseArgs(op, ['p.json', '--dry-run', '7']), { policy: 'p.json', dryRun: '7' });
  assert.deepEqual(parseArgs(op, ['p.json']), { policy: 'p.json' });
  assert.throws(() => parseArgs(op, ['--dry-run']), /needs a value/);
  assert.match(op.usage, /--dry-run <session>/);
});
