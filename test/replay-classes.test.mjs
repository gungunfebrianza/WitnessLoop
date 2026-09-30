// 3.5 in real browsers: replay-verify labels each divergence with a class and the evidence, and never hides one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserSkip } from '../examples/lib/browser.mjs';
import { startStage } from '../examples/lib/stage.mjs';
import { sendJson } from '../examples/lib/server.mjs';
import { startTodo } from '../examples/todo/server.mjs';
import { profile as todoProfile } from '../examples/todo/profile.mjs';
import { fixtureApp } from './helpers/fixture-app.mjs';
import { startProvider } from './helpers/provider.mjs';

const skip = browserSkip();
const opts = { skip: skip ?? false, timeout: 120000 };
const settle = () => new Promise((r) => setTimeout(r, 100));
const strict = () => ({ start: startTodo, profile: { ...todoProfile, volatileKeys: [] }, policy: null });
const declared = () => ({ start: startTodo, profile: todoProfile, policy: null }); // "created" declared volatile, as the example does

async function addTodos(client) {
  const sid = await client.startSession({ goal: 'todo' });
  for (const t of ['buy milk', 'walk dog']) {
    await client.cmd('dom.fill', { selector: '#new', value: t });
    await client.cmd('dom.click', { selector: '#add' });
  }
  await client.endSession(sid);
  return sid;
}

test('an exact replay has no divergences at all', opts, async () => {
  const stage = await startStage('todo', { def: strict(), relayOptions: { recordNondeterminism: true } });
  try {
    const r = await stage.client.replayVerify(await addTodos(stage.client), { shadow: 'shadow' });
    assert.equal(r.reproduced, true);
    assert.deepEqual(r.divergences, []);
    assert.deepEqual(r.classes, { volatile: 0, nondeterministic: 0, external: 0, unknown: 0 });
  } finally { await stage.close(); }
});

test('clock reads the recording does not hold: nondeterministic, with the evidence, and the replay is not reproduced', opts, async () => {
  const stage = await startStage('todo', { def: strict() });
  try {
    const r = await stage.client.replayVerify(await addTodos(stage.client), { shadow: 'shadow' });
    assert.equal(r.reproduced, false);
    assert.ok(r.classes.nondeterministic >= 1);
    assert.equal(r.classes.volatile, 0);
    assert.ok(r.divergences.every((d) => d.ok === false), 'nothing is ok: no key was declared volatile');
    const fin = r.divergences.find((d) => d.where === 'final');
    assert.equal(fin.class, 'nondeterministic');
    assert.ok(fin.paths.some((p) => p.endsWith('.created')));
    assert.ok(fin.evidence.some((e) => /drew 1 clock value\(s\) \(Date\.now \/ new Date\) that the recording did not hold/.test(e.what)));
  } finally { await stage.close(); }
});

test('the same difference inside a declared volatile key is labelled volatile: reported, ok, and the replay still reproduces', opts, async () => {
  const stage = await startStage('todo', { def: declared() });
  try {
    const r = await stage.client.replayVerify(await addTodos(stage.client), { shadow: 'shadow' });
    assert.equal(r.reproduced, true);
    assert.ok(r.classes.volatile >= 1, 'not hidden: the volatile difference is in the report');
    assert.equal(r.classes.nondeterministic + r.classes.external + r.classes.unknown, 0);
    assert.ok(r.divergences.every((d) => d.class === 'volatile' && d.ok === true));
    assert.ok(r.divergences[0].paths.every((p) => p.endsWith('.created')));
  } finally { await stage.close(); }
});

test('an autoIncrement generator that did not come back is classified nondeterministic at the restore and in the final state', opts, async () => {
  const stage = await startStage('autoinc', { def: fixtureApp('autoinc') });
  try {
    const { client } = stage;
    const sid = await client.startSession({});
    const add = async (t) => { await client.cmd('dom.fill', { selector: '#new', value: t }); await client.cmd('dom.click', { selector: '#add' }); };
    await add('a'); await add('b'); await add('c');
    await client.cmd('dom.click', { selector: '.del', nth: 2 });
    await add('d');
    await client.endSession(sid);
    const from = (await client.events(sid)).find((e) => e.kind === 'command' && e.data.params.value === 'd').idx;
    const f = await client.fork(sid, { shadow: 'shadow', at: from });
    assert.equal(f.counterfactual, false);
    const restore = f.divergences.find((d) => d.where === 'restore');
    assert.equal(restore.class, 'nondeterministic');
    assert.match(restore.evidence[0].what, /IndexedDB app\/items: the autoIncrement key generator is at 3 after restore, not the recorded 4/);
    const fin = f.divergences.find((d) => d.where === 'final');
    assert.equal(fin.class, 'nondeterministic', 'the differing rows are in the store whose generator drifted');
    assert.ok(f.divergences.every((d) => !d.ok));
  } finally { await stage.close(); }
});

test('honesty: with no recording, a live provider giving a new answer is NOT called external (nothing proves it), it is unknown', opts, async () => {
  const provider = await startProvider();
  const api = async (req, res, url) => { if (url.pathname === '/config.json') { sendJson(res, 200, { provider: provider.origin }); return true; } return false; };
  const stage = await startStage('provider', { def: fixtureApp('provider', {}, { api }) });
  try {
    const sid = await stage.client.startSession({});
    await stage.client.cmd('dom.click', { selector: '#buy' });
    await stage.client.endSession(sid);
    const r = await stage.client.replayVerify(sid, { shadow: 'shadow' });
    assert.equal(r.reproduced, false);
    assert.equal(r.classes.external, 0, 'a GET the observer does not record leaves no evidence, so no label beyond unknown');
    assert.ok(r.classes.unknown >= 1);
    assert.ok(r.divergences.every((d) => d.evidence.every((e) => e.class === 'unknown')));
  } finally { await stage.close(); await provider.close(); await settle(); }
});

test('a counterfactual fork (skip or override) differs on purpose and is not classified', opts, async () => {
  const stage = await startStage('todo', { def: declared() });
  try {
    const sid = await addTodos(stage.client);
    const firstAdd = (await stage.client.events(sid)).find((e) => e.kind === 'command' && e.data.params.selector === '#add').idx;
    const f = await stage.client.fork(sid, { shadow: 'shadow', skip: [firstAdd] });
    assert.equal(f.counterfactual, true);
    assert.deepEqual(f.divergences, []);
    assert.equal(f.classes, null);
    assert.equal(f.finalState.same, false, 'the difference itself is still reported');
  } finally { await stage.close(); }
});
