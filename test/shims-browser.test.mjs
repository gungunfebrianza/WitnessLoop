// 3.2 in a REAL browser: the todo page stamps every row with Date.now(). With no volatileKeys at all, a replay reproduces those timestamps
// exactly when production recorded what the page drew and the shadow is fed it; without a recording it does not, and says why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserSkip } from '../examples/lib/browser.mjs';
import { startStage } from '../examples/lib/stage.mjs';
import { startTodo } from '../examples/todo/server.mjs';
import { profile as todoProfile } from '../examples/todo/profile.mjs';

const skip = browserSkip();
const strict = () => ({ start: startTodo, profile: { ...todoProfile, volatileKeys: [] }, policy: null }); // "created" is NOT declared volatile
const rows = (w) => w.page.indexedDB['todo-db'].stores.todos.rows.map((r) => r.value);

async function run(client) {
  const sid = await client.startSession({ goal: 'todo' });
  for (const t of ['buy milk', 'walk dog']) {
    await client.cmd('dom.fill', { selector: '#new', value: t });
    await client.cmd('dom.click', { selector: '#add' });
  }
  await client.endSession(sid);
  return sid;
}

test('recorded draws make a replay reproduce Date.now() timestamps exactly, with no volatileKeys', { skip: skip ?? false, timeout: 120000 }, async () => {
  const stage = await startStage('todo', { def: strict(), relayOptions: { recordNondeterminism: true } });
  try {
    const sid = await run(stage.client);
    const prod = rows(await stage.world('default'));
    assert.equal(prod.length, 2);
    assert.ok(prod.every((r) => r.created > 1e12), 'production stamped real wall-clock times');

    const events = await stage.client.events(sid);
    assert.equal(events[0].data.recording.nondeterminism, true);
    const adds = events.filter((e) => e.kind === 'command' && e.data.params.selector === '#add');
    assert.ok(adds.every((e) => e.data.result.nondet.now.length === 1), 'each add recorded the one clock read it made');
    assert.deepEqual(adds.map((e) => e.data.result.nondet.now[0]), prod.map((r) => r.created));

    const r = await stage.client.replayVerify(sid, { shadow: 'shadow' });
    assert.equal(r.reproduced, true, JSON.stringify(r.firstDivergence));
    assert.deepEqual(rows(await stage.world('shadow')).map((x) => x.created), prod.map((x) => x.created), 'the shadow row timestamps ARE the production ones');
    const start = (await stage.client.events(r.forkSession)).find((e) => e.kind === 'fork.start');
    assert.equal(start.data.shims.mode, 'recorded');
    assert.equal(start.data.shims.recorded_commands, 2);
    const steps = (await stage.client.events(r.forkSession)).filter((e) => e.kind === 'command' && e.data.params.selector === '#add');
    assert.ok(steps.every((e) => e.data.result.nondet.used.now === 1 && e.data.result.nondet.fed.now === 1), 'the shadow drew exactly what it was fed');
  } finally { await stage.close(); }
});

test('control: without a recording the same replay does NOT reproduce, and the fork says the clock was seeded, not recorded', { skip: skip ?? false, timeout: 120000 }, async () => {
  const stage = await startStage('todo', { def: strict() });
  try {
    const sid = await run(stage.client);
    const prod = rows(await stage.world('default'));
    const events = await stage.client.events(sid);
    assert.equal(events[0].data.recording, undefined);
    assert.ok(events.filter((e) => e.kind === 'command').every((e) => !('nondet' in e.data.result)), 'nothing recorded unless the operator opted in');

    const r = await stage.client.replayVerify(sid, { shadow: 'shadow' });
    assert.equal(r.reproduced, false, 'a virtual clock is not the wall clock the production page saw');
    const shadow = rows(await stage.world('shadow'));
    assert.notDeepEqual(shadow.map((x) => x.created), prod.map((x) => x.created));
    const base = (await stage.client.events(r.forkSession)).find((e) => e.kind === 'fork.start').data.shims.base;
    assert.ok(shadow.every((x) => x.created >= base && x.created - base < 1000), 'the shadow used the seeded clock (session start time plus a few ticks), not the real one');
    const again = await stage.client.replayVerify(sid, { shadow: 'shadow' });
    assert.deepEqual(rows(await stage.world('shadow')).map((x) => x.created), shadow.map((x) => x.created), 'and the seeded clock is deterministic: a second replay gets the same values');
    const start = (await stage.client.events(r.forkSession)).find((e) => e.kind === 'fork.start');
    assert.equal(start.data.shims.mode, 'seeded');
    assert.equal(again.forkSession !== r.forkSession, true);
  } finally { await stage.close(); }
});

test('shims exist in the shadow only: production pages keep the real clock, and a disarmed shadow gets it back', { skip: skip ?? false, timeout: 120000 }, async () => {
  const stage = await startStage('todo', { def: strict() });
  try {
    const sid = await run(stage.client);
    const realNow = () => stage.prod.browser.evaluate('Date.now()');
    assert.ok(Math.abs((await realNow()) - Date.now()) < 60000, 'production is not shimmed');
    await stage.client.replayVerify(sid, { shadow: 'shadow' });
    const shadowNow = await stage.shadow.browser.evaluate('Date.now()');
    assert.ok(Math.abs(shadowNow - Date.now()) < 60000, 'after the replay the shadow page is disarmed and tells real time again');
    assert.equal(await stage.shadow.browser.evaluate('sessionStorage.getItem("witness_shim")'), null);
    assert.equal(await stage.shadow.browser.evaluate('new Date() instanceof Date && typeof Date.UTC(2020, 0, 1) === "number" && Date.parse("2020-01-01") > 0'), true, 'the Date proxy keeps the statics and instanceof working');
  } finally { await stage.close(); }
});

test('Math.random in an armed page is seeded and repeatable; disarmed it is random again', { skip: skip ?? false, timeout: 120000 }, async () => {
  const stage = await startStage('todo', { def: strict() });
  try {
    const draw = () => stage.shadow.browser.evaluate('[Math.random(), Math.random(), Math.random()]');
    await stage.relay.dispatch('shadow', 'shim.arm', { seed: 12345, base: 1000 });
    const a = await draw();
    await stage.relay.dispatch('shadow', 'shim.arm', { seed: 12345, base: 1000 });
    assert.deepEqual(await draw(), a, 'same seed, same sequence');
    await stage.relay.dispatch('shadow', 'shim.arm', { seed: 999, base: 1000 });
    assert.notDeepEqual(await draw(), a, 'another seed, another sequence');
    assert.equal(await stage.shadow.browser.evaluate('[Date.now(), Date.now()].join()'), '1000,1001', 'the virtual clock starts at the recorded base and ticks');
    await stage.relay.dispatch('shadow', 'shim.disarm', {});
    assert.notDeepEqual(await draw(), await draw(), 'disarmed: real randomness');
    assert.ok(Math.abs((await stage.shadow.browser.evaluate('Date.now()')) - Date.now()) < 60000);
  } finally { await stage.close(); }
});
