import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withBank, transferVia, waitFor } from './helpers/relay.mjs';

const kinds = (events) => events.map((e) => e.kind);

test('session start needs a connected agent, checkpoints genesis, and one active session per agent', async () => {
  await withBank(async ({ client }) => {
    await assert.rejects(client.startSession({ agent: 'ghost' }), /not connected/);
    const sid = await client.startSession({ goal: 't' });
    const ev = await client.events(sid);
    assert.deepEqual(kinds(ev).slice(0, 2), ['session.start', 'checkpoint']);
    assert.equal(ev[1].data.label, 'genesis');
    await assert.rejects(client.startSession({ goal: 'again' }), /already has an active session/);
    await client.endSession(sid);
    const v = await client.verify(sid, true);
    assert.ok(v.ok, JSON.stringify(v.problems));
  });
});

test('command errors: unknown type, no session, internal type', async () => {
  await withBank(async ({ client }) => {
    await assert.rejects(client.cmd('dom.query', { selector: '#balances' }), /no active session/);
    const sid = await client.startSession({});
    await assert.rejects(client.cmd('nope'), /unknown command/);
    await assert.rejects(client.cmd('world.restore', {}), /internal/);
    await client.endSession(sid);
  });
});

test('reads and reversible writes run un-gated; each write is followed by a checkpoint', async () => {
  await withBank(async ({ client }) => {
    const sid = await client.startSession({});
    const q = await client.cmd('dom.query', { selector: '#balances' });
    assert.equal(q.ok, true);
    await client.cmd('dom.fill', { selector: '#to', value: 'bob' });
    const ev = await client.events(sid);
    assert.deepEqual(kinds(ev), ['session.start', 'checkpoint', 'command', 'command', 'checkpoint']);
    assert.ok(!kinds(ev).includes('intent'));
    await client.endSession(sid);
  });
});

test('irreversible click: intent and decision are on the ledger BEFORE the command, and a human releases it', async () => {
  await withBank(async ({ client, bank }) => {
    const sid = await client.startSession({});
    await client.cmd('dom.fill', { selector: '#to', value: 'bob' });
    await client.cmd('dom.fill', { selector: '#amount', value: '100' });
    const inflight = client.cmd('dom.click', { selector: '#send' });
    const [p] = await waitFor(async () => { const l = await client.pending(); return l.length ? l : null; });
    assert.equal(p.preview.to, 'bob');
    assert.equal(p.preview.amount, '100');
    assert.equal(bank.state.bank.balances.bob, 50000, 'nothing moved while the intent is pending');
    assert.ok(!bank.agent.seen.some((s) => s.type === 'dom.click'), 'the click was not even dispatched');
    await client.approve(p.id, { by: 'reviewer-1', reason: 'looks right' });
    const out = await inflight;
    assert.equal(out.ok, true);
    assert.equal(bank.state.bank.balances.bob, 60000);
    const ev = await client.events(sid);
    const seq = kinds(ev);
    const i = seq.indexOf('intent');
    assert.deepEqual(seq.slice(i, i + 6), ['intent', 'decision', 'decision', 'command.begin', 'command', 'checkpoint']);
    assert.equal(ev[i + 1].data.verdict, 'require_approval');
    assert.equal(ev[i + 2].data.by, 'reviewer-1');
    assert.equal(ev[i + 2].data.verdict, 'allow');
    assert.ok(ev[i + 2].idx < ev[i + 3].idx, 'decision precedes the write-ahead begin');
    assert.equal(ev[i + 3].data.intent_idx, ev[i].idx);
    assert.equal(ev[i + 4].data.begin_idx, ev[i + 3].idx, 'the result references its begin');
    assert.equal(ev[i + 4].data.intent_idx, ev[i].idx);
    await client.endSession(sid);
    assert.ok((await client.verify(sid, true)).ok);
  });
});

test('a human denial leaves no command event and moves no money', async () => {
  await withBank(async ({ client, bank }) => {
    const sid = await client.startSession({});
    await client.cmd('dom.fill', { selector: '#to', value: 'carol' });
    await client.cmd('dom.fill', { selector: '#amount', value: '20' });
    const inflight = client.cmd('dom.click', { selector: '#send' });
    const [p] = await waitFor(async () => { const l = await client.pending(); return l.length ? l : null; });
    await client.deny(p.id, { by: 'reviewer-2', reason: 'not expected' });
    const out = await inflight;
    assert.equal(out.denied, true);
    assert.equal(out.ok, false);
    assert.equal(bank.state.bank.balances.carol, 25000);
    const ev = await client.events(sid);
    assert.ok(!ev.some((e) => e.kind === 'command' && e.type === 'dom.click'));
    assert.equal(ev.filter((e) => e.kind === 'decision').at(-1).data.verdict, 'deny');
    await client.endSession(sid);
  });
});

test('policy auto-allows small transfers to known payees and denies the rest without asking', async () => {
  const policy = {
    default: 'deny',
    rules: [{ when: { 'preview.amount': { lte: 100 }, 'preview.to': { in: ['bob'] } }, then: 'allow', reason: 'small to bob' }],
  };
  await withBank(async ({ client, bank }) => {
    const sid = await client.startSession({});
    const ok = await transferVia(client, 'bob', 40);
    assert.equal(ok.ok, true);
    const no = await transferVia(client, 'bob', 400);
    assert.equal(no.denied, true);
    assert.match(no.reason, /policy default/);
    const no2 = await transferVia(client, 'carol', 10);
    assert.equal(no2.denied, true);
    assert.equal(bank.state.bank.balances.bob, 54000);
    assert.equal((await client.pending()).length, 0, 'nothing waited on a human');
    const ev = await client.events(sid);
    assert.equal(ev.filter((e) => e.kind === 'command' && e.type === 'dom.click').length, 1);
    assert.equal(ev.filter((e) => e.kind === 'intent').length, 3);
    await client.endSession(sid);
  }, { policy });
});

test('fail closed: if the ledger cannot record the decision, the click is never dispatched', async () => {
  await withBank(async ({ relay, client, bank }) => {
    const sid = await client.startSession({});
    await client.cmd('dom.fill', { selector: '#to', value: 'bob' });
    await client.cmd('dom.fill', { selector: '#amount', value: '10' });
    const realAppend = relay.ledger.append.bind(relay.ledger);
    relay.ledger.append = (id, e) => { if (e.kind === 'decision') throw new Error('disk full'); return realAppend(id, e); };
    await assert.rejects(client.cmd('dom.click', { selector: '#send' }), /disk full/);
    relay.ledger.append = realAppend;
    assert.ok(!bank.agent.seen.some((s) => s.type === 'dom.click'), 'proof did not exist, so the effect did not happen');
    assert.equal(bank.state.bank.balances.bob, 50000);
    await client.endSession(sid);
  }, { policy: { default: 'allow' } });
});

test('an unanswered approval times out as a denial', async () => {
  await withBank(async ({ client, bank }) => {
    const sid = await client.startSession({});
    await client.cmd('dom.fill', { selector: '#to', value: 'bob' });
    await client.cmd('dom.fill', { selector: '#amount', value: '10' });
    const out = await client.cmd('dom.click', { selector: '#send' });
    assert.equal(out.denied, true);
    assert.equal(out.reason, 'approval_timeout');
    assert.equal(bank.state.bank.balances.bob, 50000);
    await client.endSession(sid);
  }, { approvalTimeoutMs: 150 });
});

test('effectCheck flags an effect the preview did not promise, on the ledger', async () => {
  const profile = {
    volatileKeys: ['at'],
    effectCheck: ({ preview, before, after }) => {
      const moved = after.server.balances.bob - before.server.balances.bob;
      const promised = Math.round(Number(preview.amount) * 100);
      return moved === promised ? { ok: true } : { ok: false, why: `bob got ${moved} cents, preview promised ${promised}` };
    },
  };
  await withBank(async ({ client, bank }) => {
    const sid = await client.startSession({});
    await transferVia(client, 'bob', 5);
    assert.ok(!(await client.events(sid)).some((e) => e.kind === 'flag'), 'honest transfer is not flagged');
    // sabotage: the "server" credits bob one extra cent, so the actual effect differs from the preview
    bank.state.afterTransfer = (b) => { b.balances.bob += 1; };
    const out = await transferVia(client, 'bob', 10);
    assert.equal(out.ok, true, 'the command itself succeeded');
    assert.match(out.flagged.why, /bob got 1001 cents, preview promised 1000/);
    const flag = (await client.events(sid)).find((e) => e.kind === 'flag');
    assert.equal(flag.type, 'effect_mismatch');
    assert.equal(flag.ok, 0);
    assert.equal(flag.data.command_idx, out.idx);
    await client.endSession(sid);
  }, { policy: { default: 'allow' }, profile });
});

test('write-ahead: a result that cannot be recorded leaves an unresolved dispatch that verify reports', async () => {
  await withBank(async ({ client, relay, bank }) => {
    const sid = await client.startSession({});
    const real = relay.ledger.append.bind(relay.ledger);
    relay.ledger.append = (id, e) => { if (e.kind === 'command' && e.type === 'dom.click') throw new Error('disk full'); return real(id, e); };
    await client.cmd('dom.fill', { selector: '#to', value: 'bob' });
    await client.cmd('dom.fill', { selector: '#amount', value: '5' });
    await assert.rejects(client.cmd('dom.click', { selector: '#send' }), /disk full/);
    relay.ledger.append = real;
    assert.ok(bank.agent.seen.some((m) => m.type === 'dom.click'), 'the click really reached the page');
    const begin = relay.ledger.events(sid).find((e) => e.kind === 'command.begin');
    assert.ok(begin, 'the begin was recorded before the click');
    const soft = await client.verify(sid, false);
    assert.equal(soft.ok, true);
    assert.equal(soft.warnings.length, 1);
    assert.match(soft.warnings[0].reason, /unresolved dispatch/);
    assert.equal(soft.warnings[0].idx, begin.idx);
    const hard = await client.verify(sid, true);
    assert.equal(hard.ok, false);
    assert.ok(hard.problems.some((p) => p.idx === begin.idx && /unresolved dispatch/.test(p.reason)));
    const report = (await client.report(sid)).markdown;
    assert.match(report, /UNRESOLVED DISPATCHES: 1/);
    await client.endSession(sid);
  }, { policy: { default: 'allow' } });
});

test('write-ahead: if the begin cannot be recorded, nothing is dispatched', async () => {
  await withBank(async ({ client, relay, bank }) => {
    await client.startSession({});
    const real = relay.ledger.append.bind(relay.ledger);
    relay.ledger.append = (id, e) => { if (e.kind === 'command.begin') throw new Error('disk full'); return real(id, e); };
    await client.cmd('dom.fill', { selector: '#to', value: 'bob' });
    await client.cmd('dom.fill', { selector: '#amount', value: '5' });
    await assert.rejects(client.cmd('dom.click', { selector: '#send' }), /disk full/);
    relay.ledger.append = real;
    assert.ok(!bank.agent.seen.some((m) => m.type === 'dom.click'), 'no click was dispatched');
  }, { policy: { default: 'allow' } });
});
