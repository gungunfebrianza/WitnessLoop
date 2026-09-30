// 3.6: a recorded value_flow edge next to the inferred ones. The families stay separate: nothing inferred is ever promoted to recorded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCausal, ancestors } from '../src/causal.mjs';
import { browserSkip } from '../examples/lib/browser.mjs';
import { startStage } from '../examples/lib/stage.mjs';
import { stories } from '../examples/agents/stories.mjs';

const skip = browserSkip();
const EMAIL = 'sam.leigh@rival.example';
const read = (idx, flow, items = [{ text: 'Sam Leigh', data: { email: EMAIL } }]) => ({ idx, kind: 'command', type: 'dom.query', effect: 'read', ok: 1, data: { params: { selector: '#contacts li' }, result: { matchCount: items.length, items, ...(flow ? { flow } : {}) } } });
const fill = (idx, value, flow) => ({ idx, kind: 'command', type: 'dom.fill', effect: 'reversible', ok: 1, data: { params: { selector: '#to', value }, result: { filled: true, value, ...(flow ? { flow } : {}) } } });
const edges = (events, kind) => buildCausal(events).edges.filter((e) => e.kind === kind);

test('a value the page agent served in a read and saw typed back is a RECORDED edge, and the heuristic edge for the same pair stays inferred', () => {
  const g = buildCausal([read(2, { seq: 1, load: 'L1' }), fill(4, EMAIL, { load: 'L1', from: [{ param: 'value', seq: 1 }] })]);
  const vf = g.edges.filter((e) => e.kind === 'value_flow');
  assert.equal(vf.length, 1);
  assert.deepEqual([vf[0].cause, vf[0].effect, vf[0].inferred], [2, 4, false]);
  assert.equal(vf[0].detail.param, 'value');
  assert.match(vf[0].detail.basis, /exact string the page agent served/);
  const df = g.edges.filter((e) => e.kind === 'derived_from');
  assert.equal(df.length, 1, 'the heuristic still finds the same pair');
  assert.equal(df[0].inferred, true, 'and it is NOT upgraded because a recorded edge exists');
  assert.ok(g.edges.every((e) => (e.kind === 'value_flow' ? e.inferred === false : true)));
  assert.ok(g.edges.filter((e) => e.kind === 'derived_from' || e.kind === 'observes').every((e) => e.inferred === true), 'derived_from and observes are inferred under every input');
  assert.ok(ancestors(g, 4).some((a) => a.idx === 2 && a.via === 'value_flow' && a.inferred === false));
});

test('a heuristic-only pair (no flow recorded by the page agent) gets NO value_flow edge: inferred edges are never promoted', () => {
  const g = buildCausal([read(2, { seq: 1, load: 'L1' }), fill(4, EMAIL)]);
  assert.equal(g.edges.filter((e) => e.kind === 'value_flow').length, 0);
  const df = g.edges.filter((e) => e.kind === 'derived_from');
  assert.equal(df.length, 1);
  assert.equal(df[0].inferred, true);
  // a substring match, which the heuristic accepts, is never enough for a recorded edge
  const sub = buildCausal([read(2, { seq: 1, load: 'L1' }), fill(4, 'rival.example')]);
  assert.equal(sub.edges.filter((e) => e.kind === 'value_flow').length, 0);
  assert.equal(sub.edges.filter((e) => e.kind === 'derived_from')[0].inferred, true);
});

test('a forged or inconsistent flow report adds nothing: unknown seq, other page load, a read that came later, malformed fields', () => {
  const at = (events) => edges(events, 'value_flow').length;
  assert.equal(at([read(2, { seq: 1, load: 'L1' }), fill(4, EMAIL, { load: 'L1', from: [{ param: 'value', seq: 9 }] })]), 0, 'no read was ever served with that seq');
  assert.equal(at([read(2, { seq: 1, load: 'L1' }), fill(4, EMAIL, { load: 'OTHER', from: [{ param: 'value', seq: 1 }] })]), 0, 'a different page load is a different counter');
  assert.equal(at([fill(2, EMAIL, { load: 'L1', from: [{ param: 'value', seq: 1 }] }), read(4, { seq: 1, load: 'L1' })]), 0, 'a fill cannot draw from a read that happened after it');
  assert.equal(at([read(2, { seq: 1, load: 'L1' }), fill(4, EMAIL, { load: 'L1', from: [{ param: 'value', seq: '1' }, { param: 'value' }, null, 'x'] })]), 0);
  assert.equal(at([read(2, { seq: 1, load: 'L1' }), fill(4, EMAIL, { load: 5, from: [{ param: 'value', seq: 1 }] })]), 0);
  assert.equal(at([read(2, { seq: 1, load: 'L1' }), fill(4, EMAIL, { load: 'L1', from: 'nope' })]), 0);
  // a read cannot claim to be the destination of a flow
  assert.equal(at([read(2, { seq: 1, load: 'L1' }), { ...read(4, { seq: 2, load: 'L1' }), data: { params: { selector: 'x' }, result: { flow: { load: 'L1', from: [{ param: 'value', seq: 1 }] } } } }]), 0);
});

test('two fills from the same read, and a value re-read later, each get their own edge from the right read', () => {
  const g = buildCausal([
    read(2, { seq: 1, load: 'L1' }), read(4, { seq: 2, load: 'L1' }),
    fill(6, EMAIL, { load: 'L1', from: [{ param: 'value', seq: 1 }] }), fill(8, 'x', { load: 'L1', from: [{ param: 'value', seq: 2 }] }),
  ]);
  assert.deepEqual(g.edges.filter((e) => e.kind === 'value_flow').map((e) => [e.cause, e.effect]), [[2, 6], [4, 8]]);
});

// ---- real page ----
test('mailer in a real browser: the address the agent read from the contacts list and typed into #to is recorded as value_flow', { skip: skip ?? false, timeout: 120000 }, async () => {
  const stage = await startStage('mailer');
  try {
    const r = await stories.mailer.story(stage);
    const events = await stage.client.events(r.sid);
    const causal = await stage.client.causal(r.sid);
    const vf = causal.edges.filter((e) => e.kind === 'value_flow');
    assert.ok(vf.length >= 1, 'the wrong-Sam address came from a read');
    assert.ok(vf.every((e) => e.inferred === false));
    const filled = events.find((e) => e.idx === vf.at(-1).effect);
    assert.equal(filled.type, 'dom.fill');
    assert.equal(filled.data.params.value, 'sam.leigh@rival.example');
    const src = events.find((e) => e.idx === vf.at(-1).cause);
    assert.equal(src.type, 'dom.query');
    assert.ok(JSON.stringify(src.data.result.items).includes('sam.leigh@rival.example'));
    assert.ok(causal.edges.filter((e) => e.kind === 'derived_from').every((e) => e.inferred === true));
    // the replay compares results with the per-load flow ids ignored: the story still reproduces
    assert.equal(r.replay.reproduced, true);
  } finally { await stage.close(); }
});
