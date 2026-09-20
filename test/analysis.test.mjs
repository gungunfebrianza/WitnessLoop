import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withBankPair, transferVia } from './helpers/relay.mjs';
import { INITIAL_TOTAL, totalMoney } from '../examples/bank/model.mjs';
import { buildCausal, ancestors } from '../src/causal.mjs';
import { buildReport } from '../src/report.mjs';

// alice pays: $100 (clean), $33.33 (leaks a cent), $1.00 (leaks), $100 (clean)
async function sloppyRun(client, amounts = [100, 33.33, '1.00', 100]) {
  const sid = await client.startSession({ goal: 'pay people' });
  for (const a of amounts) await transferVia(client, 'bob', a);
  await client.endSession(sid);
  return sid;
}

const patched = { default: 'allow', rules: [{ when: { 'preview.amount': { matches: '\\.\\d\\d$' } }, then: 'deny', reason: 'no fractional-cent-fee amounts' }] };

test('the planted bank bug is real: $33.33 leaks a cent, $100 does not', async () => {
  await withBankPair(async ({ client, bank }) => {
    await sloppyRun(client, [100]);
    assert.equal(totalMoney(bank.state.bank), INITIAL_TOTAL);
    await sloppyRun(client, [33.33]);
    assert.equal(totalMoney(bank.state.bank), INITIAL_TOTAL - 1);
  });
});

test('bisect names the first transfer that broke conservation, who approved it, and what changed', async () => {
  await withBankPair(async ({ client }) => {
    const sid = await sloppyRun(client);
    const r = await client.bisect(sid);
    assert.equal(r.found, true);
    assert.equal(r.firstBad.command.type, 'dom.click');
    assert.match(r.firstBad.why, /money not conserved.*-1 cents/);
    assert.equal(r.firstBad.approvedBy, 'policy');
    const amountFill = (await client.events(sid)).filter((e) => e.type === 'dom.fill' && e.data.params.selector === '#amount').find((e) => e.data.params.value === '33.33');
    assert.ok(r.firstBad.causes.some((c) => c.idx === amountFill.idx) || r.firstBad.commandIdx > amountFill.idx);
    assert.ok(r.firstBad.stateDiff.some((d) => d.path === 'server.fees'));
    assert.ok(r.firstBad.commandIdx > 0);
  });
});

test('binary search agrees with linear and evaluates far fewer checkpoints', async () => {
  await withBankPair(async ({ client }) => {
    const amounts = Array(14).fill(100).concat([33.33, 100, 100]);
    const sid = await sloppyRun(client, amounts);
    const lin = await client.bisect(sid, { search: 'linear' });
    const bin = await client.bisect(sid, { search: 'binary' });
    assert.equal(bin.firstBad.commandIdx, lin.firstBad.commandIdx);
    assert.ok(bin.evaluations < lin.evaluations, `${bin.evaluations} < ${lin.evaluations}`);
    assert.ok(bin.evaluations <= Math.ceil(Math.log2(bin.checkpoints)) + 3);
  });
});

test('bisect on a clean session finds nothing', async () => {
  await withBankPair(async ({ client }) => {
    const sid = await sloppyRun(client, [100, 200]);
    const r = await client.bisect(sid);
    assert.equal(r.found, false);
  });
});

test('fork with a patched policy denies the bad transfer in the shadow; production is untouched', async () => {
  await withBankPair(async ({ client, bank, shadow }) => {
    const sid = await sloppyRun(client);
    const prodBefore = JSON.stringify(bank.state.bank);
    const r = await client.fork(sid, { shadow: 'shadow', policy: patched });
    assert.equal(r.restoreVerified, true);
    assert.equal(JSON.stringify(bank.state.bank), prodBefore, 'production state never touched');
    const denied = r.steps.filter((s) => s.denied);
    assert.equal(denied.length, 2, '$33.33 and $1.00 refused');
    assert.equal(r.firstDivergence.denied, true);
    assert.equal(totalMoney(shadow.state.bank), INITIAL_TOTAL, 'the fork conserves money');
    assert.notEqual(totalMoney(bank.state.bank), INITIAL_TOTAL, 'the original did not');
    assert.equal(r.finalState.same, false);
    const v = await client.verify(r.forkSession, true);
    assert.ok(v.ok, JSON.stringify(v.problems));
    const cmp = await client.compare(sid, r.forkSession);
    assert.equal(cmp.firstDivergence.reason, 'refused in the second session');
    assert.ok(cmp.finalState.diff.some((d) => d.path === 'server.fees'));
  });
});

test('fork can override one recorded parameter (counterfactual) and skip a step', async () => {
  await withBankPair(async ({ client, shadow }) => {
    const sid = await sloppyRun(client, [100, 33.33]);
    const ev = await client.events(sid);
    const fill = ev.find((e) => e.type === 'dom.fill' && e.data.params.value === '33.33');
    const r = await client.fork(sid, { shadow: 'shadow', at: fill.idx, override: { [fill.idx]: { value: '10.00' } } });
    assert.equal(r.steps.find((s) => s.parentIdx === fill.idx).overridden, true);
    assert.equal(r.steps.find((s) => s.parentIdx === fill.idx).params.value, '10.00');
    // $10.00 -> 1000c*1.5% = 15c exactly: no leak in the counterfactual
    assert.equal(totalMoney(shadow.state.bank), INITIAL_TOTAL);
    assert.equal(shadow.state.bank.balances.bob, 50000 + 10000 + 1000);
  });
});

test('shadow-only: a fork onto the parent\'s own agent is refused unless forced', async () => {
  await withBankPair(async ({ client }) => {
    const sid = await sloppyRun(client, [100]);
    await assert.rejects(client.fork(sid, { shadow: 'default' }), /never re-run production/);
    await assert.rejects(client.fork(sid, {}), /shadow agent/);
    const forced = await client.fork(sid, { shadow: 'default', forceSame: true });
    assert.ok(forced.forkSession);
  });
});

test('replay-verify: an untouched replay reproduces every step and the final world', async () => {
  await withBankPair(async ({ client }) => {
    const sid = await sloppyRun(client);
    const r = await client.replayVerify(sid, { shadow: 'shadow' });
    assert.equal(r.reproduced, true, JSON.stringify(r.firstDivergence ?? r.finalState.diff));
    assert.equal(r.firstDivergence, null);
    assert.ok(r.steps >= 12);
    assert.ok((await client.verify(r.forkSession, true)).ok);
  });
});

test('replay-verify catches an environment that no longer reproduces the recorded outcome', async () => {
  await withBankPair(async ({ client, shadow }) => {
    const sid = await sloppyRun(client, [100]);
    shadow.state.afterTransfer = (b) => { b.balances.carol += 7; };
    const r = await client.replayVerify(sid, { shadow: 'shadow' });
    assert.equal(r.reproduced, false);
    assert.ok(r.finalState.diff.some((d) => d.path === 'server.balances.carol'));
  });
});

test('causal graph: recorded structure, retries, and inferred provenance are kept apart', async () => {
  await withBankPair(async ({ client }) => {
    const sid = await client.startSession({});
    await client.cmd('dom.query', { selector: '#balances' });
    await client.cmd('dom.fill', { selector: '#to', value: 'bob' });
    await client.cmd('dom.fill', { selector: '#amount', value: '50000' }); // 50000 is bob's balance, first seen in the read
    await client.cmd('dom.click', { selector: '#send' });
    await client.cmd('dom.fill', { selector: '#to', value: 'bob' });
    await client.cmd('dom.fill', { selector: '#amount', value: '999999' });
    const bad1 = await client.cmd('dom.click', { selector: '#send' });
    const bad2 = await client.cmd('dom.click', { selector: '#send' });
    await client.cmd('dom.query', { selector: '#balances' });
    await client.endSession(sid);
    assert.equal(bad1.ok, false);
    const g = await client.causal(sid);
    const kinds = new Set(g.edges.map((e) => e.kind));
    for (const k of ['decided', 'released', 'state_after', 'retry_of', 'derived_from', 'observes']) assert.ok(kinds.has(k), `missing ${k}`);
    const prov = g.edges.find((e) => e.kind === 'derived_from');
    assert.equal(prov.inferred, true);
    assert.equal(prov.detail.value, '50000');
    assert.ok(g.edges.filter((e) => !e.inferred).every((e) => e.kind !== 'derived_from' && e.kind !== 'observes'));
    const retry = g.edges.find((e) => e.kind === 'retry_of' && e.effect === bad2.idx);
    assert.equal(retry.cause, bad1.idx);
    assert.ok(ancestors(g, bad2.idx).some((a) => a.idx === bad1.idx));
  });
});

test('report renders gate decisions, verification, forks and inferred edges', async () => {
  await withBankPair(async ({ client, relay }) => {
    const sid = await sloppyRun(client, [100, 33.33]);
    await client.fork(sid, { shadow: 'shadow', policy: patched });
    const { markdown } = await client.report(sid);
    assert.match(markdown, /# witnessloop report - session 1/);
    assert.match(markdown, /chain: verified/);
    assert.match(markdown, /## Gate decisions/);
    assert.match(markdown, /Forks of this session/);
    assert.match(markdown, /\| yes \|/);
    const events = relay.ledger.events(sid, { hydrate: true });
    relay.ledger.db.prepare('UPDATE events SET ok = 1 WHERE session_id = ? AND idx = 1').run(sid);
    const broken = buildReport({ session: relay.ledger.getSession(sid), events, verify: relay.ledger.verifySessionId(sid), causal: buildCausal(events) });
    assert.match(broken, /chain: BROKEN at event #1/);
  });
});
