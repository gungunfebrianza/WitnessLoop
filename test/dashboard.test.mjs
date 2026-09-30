import { test } from 'node:test';
import assert from 'node:assert/strict';
import { profile as bankExampleProfile } from '../examples/bank/profile.mjs';
import { withBank, transferVia, waitFor } from './helpers/relay.mjs';

const auth = (relay) => ({ authorization: `Bearer ${relay.token}` });
const get = async (relay, p) => (await (await fetch(`http://127.0.0.1:${relay.port}${p}`, { headers: auth(relay) })).json());
const post = async (relay, p, body) => (await (await fetch(`http://127.0.0.1:${relay.port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth(relay) }, body: JSON.stringify(body) })).json());

// two small allowed transfers, one held for a human and approved, one over the limit and denied
async function story(client) {
  const sid = await client.startSession({ goal: 'dash', actor: 'tester' });
  await client.cmd('dom.query', { selector: '#balances' });
  await transferVia(client, 'bob', 100);
  await transferVia(client, 'carol', '33.33');
  const held = transferVia(client, 'bob', 300);
  const [p] = await waitFor(async () => { const l = await client.pending(); return l.length ? l : null; });
  await client.approve(p.id, { by: 'reviewer-1' });
  await held;
  await transferVia(client, 'bob', 999999);
  await client.endSession(sid);
  return sid;
}

const POLICY = { default: 'require_approval', rules: [
  { when: { effect: 'irreversible', 'preview.amount': { lte: 150 }, 'preview.to': { in: ['bob', 'carol'] } }, then: 'allow', reason: 'small payment' },
  { when: { effect: 'irreversible', 'preview.amount': { gt: 5000 } }, then: 'deny', reason: 'hard limit' },
] };

test('dashboard page is served with a locked-down CSP and never uses innerHTML', async () => {
  await withBank(async ({ relay }) => {
    const res = await fetch(`http://127.0.0.1:${relay.port}/dashboard`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
    assert.match(res.headers.get('content-security-policy'), /connect-src 'self'/);
    const html = await res.text();
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(html), 'ledger data must only reach the DOM via textContent');
    assert.ok(!/<script[^>]+src=/.test(html) && !/https?:\/\//.test(html.replace('http://www.w3.org/2000/svg', '')), 'no external resources (the SVG namespace id is not a fetch)');
  });
});

test('overview: integrity comes from running the verifier, funnel and fleet counts match the ledger', async () => {
  await withBank(async ({ client, relay }) => {
    const sid = await story(client);
    const { result: o } = await get(relay, '/dashboard/overview');
    assert.equal(o.sessions.length, 1);
    const s = o.sessions[0];
    assert.equal(s.id, sid);
    assert.equal(s.integrity.ok, true);
    assert.equal(s.integrity.strictOk, true);
    assert.equal(s.integrity.unsealedTail, 0);
    assert.equal(s.funnel.intents, 4);
    assert.equal(s.funnel.policyAllow, 2);
    assert.equal(s.funnel.policyAsk, 1);
    assert.equal(s.funnel.humanAllow, 1);
    assert.equal(s.funnel.policyDeny, 1);
    assert.equal(s.funnel.released, 3);
    assert.equal(s.funnel.refused, 1);
    assert.equal(o.fleet[0].actor, 'tester');
    assert.equal(o.fleet[0].intents, 4);
  }, { policy: POLICY });
});

test('a corrupted ledger is reported broken, at the right event (not a stored flag)', async () => {
  await withBank(async ({ client, relay }) => {
    const sid = await story(client);
    const victim = relay.ledger.events(sid).find((e) => e.kind === 'command' && e.data_hash);
    relay.ledger.db.prepare('UPDATE blobs SET json = ? WHERE hash = ?').run('{"tampered":true}', victim.data_hash);
    const { result: o } = await get(relay, '/dashboard/overview');
    assert.equal(o.sessions[0].integrity.ok, false);
    assert.equal(o.sessions[0].integrity.badIdx, victim.idx);
    assert.equal(o.fleet[0].tampered, 1);
  }, { policy: POLICY });
});

test('a session that is not sealed to the end shows its unsealed tail', async () => {
  await withBank(async ({ client, relay }) => {
    const sid = await client.startSession({ goal: 'open' });
    await client.cmd('dom.query', { selector: '#balances' });
    const { result: d } = await get(relay, `/dashboard/sessions/${sid}`);
    assert.equal(d.summary.integrity.strictOk, false);
    assert.ok(d.summary.integrity.unsealedTail > 0);
    await client.endSession(sid);
  });
});

test('session detail: timeline, approval latency, invariant series, bisect and state diff agree', async () => {
  await withBank(async ({ client, relay }) => {
    const sid = await story(client);
    const { result: d } = await get(relay, `/dashboard/sessions/${sid}`);
    assert.equal(d.timeline.length, d.summary.events);
    const human = d.gate.intents.find((r) => r.by === 'reviewer-1');
    assert.ok(human && human.latencyMs >= 0, 'approval latency is measured from intent to the resolving decision');
    assert.equal(d.gate.latencies.length, 1);
    assert.equal(d.repeats.length, 0, 'clicking the same #send button with different form values is not a repeated intent');
    assert.equal(d.invariantSeries.length, d.checkpoints.length);
    assert.equal(d.bisect.found, true);
    const bad = d.invariantSeries.find((x) => !x.ok);
    assert.equal(bad.idx, d.bisect.firstBad.checkpointIdx, 'first failing cell equals the bisect result');
    const { result: diff } = await get(relay, `/dashboard/sessions/${sid}/diff?cp=${bad.idx}`);
    assert.ok(diff.diff.length > 0);
    const missing = await get(relay, `/dashboard/sessions/${sid}/diff?cp=9999`);
    assert.equal(missing.ok, false);
  }, { policy: POLICY });
});

test('world series: per-checkpoint balances, the deviation from the expected total, and the transfers that leaked', async () => {
  await withBank(async ({ client, relay }) => {
    const sid = await story(client);
    const { result: d } = await get(relay, `/dashboard/sessions/${sid}`);
    assert.equal(d.worldSeries.length, d.checkpoints.length);
    const dev = d.worldSeries.map((x) => x.total - x.expected);
    assert.equal(dev[0], 0, 'genesis is conserved');
    assert.equal(dev.findIndex((v) => v !== 0), d.invariantSeries.findIndex((x) => !x.ok), 'the deviation chart and the invariant strip break at the same checkpoint');
    const last = d.worldSeries.at(-1);
    assert.equal(last.parts.fees > 0, true);
    const lost = last.items.filter((x) => x.delta);
    assert.equal(lost.reduce((a, x) => a + x.delta, 0), dev.at(-1), 'cents lost across transfers equals the final deviation');
  }, { policy: POLICY, profile: bankExampleProfile });
});

test('repeated identical intents are surfaced', async () => {
  await withBank(async ({ client, relay }) => {
    const sid = await client.startSession({});
    await transferVia(client, 'bob', 999999);
    await transferVia(client, 'bob', 999999);
    await client.endSession(sid);
    const { result: d } = await get(relay, `/dashboard/sessions/${sid}`);
    assert.equal(d.repeats.length, 1);
    assert.equal(d.repeats[0].intents.length, 2);
  }, { policy: POLICY });
});

test('tamper demo: every mode is detected, and the stored ledger is untouched', async () => {
  await withBank(async ({ client, relay }) => {
    const sid = await story(client);
    const headBefore = relay.ledger.head(sid);
    for (const mode of ['payload', 'delete', 'truncate']) {
      const { result: r } = await post(relay, `/dashboard/sessions/${sid}/tamper`, { mode });
      assert.equal(r.before.ok, true, mode);
      assert.equal(r.detected, true, `${mode}: ${r.what}`);
      assert.ok(r.after.problems.length > 0);
    }
    const bad = await post(relay, `/dashboard/sessions/${sid}/tamper`, { mode: 'nope' });
    assert.equal(bad.ok, false);
    assert.deepEqual(relay.ledger.head(sid), headBefore);
    assert.equal(relay.ledger.verifySessionId(sid, { strict: true }).ok, true);
  }, { policy: POLICY });
});

test('what-if: verdict changes are computed per recorded intent under an alternative policy', async () => {
  await withBank(async ({ client, relay }) => {
    const sid = await story(client);
    const same = (await post(relay, `/dashboard/sessions/${sid}/whatif`, { policy: POLICY })).result;
    assert.equal(same.changed, 0);
    const strict = (await post(relay, `/dashboard/sessions/${sid}/whatif`, { policy: { default: 'require_approval', rules: [
      { when: { effect: 'irreversible', 'preview.amount': { matches: '\\.\\d\\d$' } }, then: 'deny', reason: 'cents' }, ...POLICY.rules] } })).result;
    assert.equal(strict.intents, 4);
    assert.equal(strict.changed, 1);
    assert.equal(strict.rows.find((r) => r.changed).alternative, 'deny');
    assert.equal((await post(relay, `/dashboard/sessions/${sid}/whatif`, { policy: { default: 'maybe' } })).ok, false);
    assert.equal((await post(relay, `/dashboard/sessions/${sid}/whatif`, {})).ok, false);
  }, { policy: POLICY });
});

test('rule hit map counts recorded intents against the current policy', async () => {
  await withBank(async ({ client, relay }) => {
    await story(client);
    const { result: o } = await get(relay, '/dashboard/overview');
    const byIdx = Object.fromEntries(o.ruleHits.map((r) => [String(r.index), r.hits]));
    assert.deepEqual(byIdx, { 0: 2, 1: 1, null: 1 });
  }, { policy: POLICY });
});

test('unknown session ids give an error, not a crash', async () => {
  await withBank(async ({ relay }) => {
    assert.equal((await get(relay, '/dashboard/sessions/999')).ok, false);
  });
});
