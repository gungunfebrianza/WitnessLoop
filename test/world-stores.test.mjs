// 3.1 and 3.4 in a REAL browser: sessionStorage, cookies and service-worker registrations round-trip through capture and restore,
// and an IndexedDB autoIncrement generator that a restore cannot rewind is measured and reported, never hidden.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserSkip } from '../examples/lib/browser.mjs';
import { startStage } from '../examples/lib/stage.mjs';
import { comparable } from '../src/world.mjs';
import { fixtureApp } from './helpers/fixture-app.mjs';

const skip = browserSkip();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const view = (w) => JSON.stringify(comparable(w));

test('sessionStorage, cookies and service workers round-trip through capture and restore; each store is checked on its own', { skip: skip ?? false, timeout: 120000 }, async () => {
  const stage = await startStage('stores', { def: fixtureApp('stores') });
  const page = stage.prod.browser;
  try {
    const w0 = await stage.world();
    assert.deepEqual(w0.page.sessionStorage, {}, 'witness_* keys are the agent\'s own and never part of the world');
    assert.deepEqual(w0.page.cookies, {});
    assert.deepEqual(w0.page.serviceWorkers, []);
    assert.match(w0.page.meta.notCaptured.join('|'), /HttpOnly/, 'the snapshot itself says what it cannot hold');

    await page.evaluate(`(async () => {
      sessionStorage.setItem('cart', 'apple'); document.cookie = 'theme=dark; path=/'; document.cookie = 'lang=en; path=/';
      const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      for (let i = 0; i < 100 && !(reg.active && reg.active.state === 'activated'); i++) await new Promise((r) => setTimeout(r, 50));
    })()`);
    const w1 = await stage.world();
    assert.deepEqual(w1.page.sessionStorage, { cart: 'apple' });
    assert.deepEqual(w1.page.cookies, { lang: 'en', theme: 'dark' });
    assert.deepEqual(w1.page.serviceWorkers, [{ scope: '/', script: '/sw.js', state: 'activated' }]);
    assert.notEqual(view(w0), view(w1), 'the new stores are part of what worlds are compared on');

    // change every store, then restore w1: each must come back
    await page.evaluate(`(async () => {
      sessionStorage.setItem('cart', 'pear'); sessionStorage.setItem('extra', '1');
      document.cookie = 'theme=light; path=/'; document.cookie = 'lang=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'; document.cookie = 'stray=1; path=/';
      for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    })()`);
    const mutated = await stage.world();
    assert.deepEqual(mutated.page.serviceWorkers, []);
    await stage.relay.restoreWorld('default', w1);
    await sleep(300);
    const back = await stage.world();
    assert.deepEqual(back.page.sessionStorage, w1.page.sessionStorage, 'sessionStorage restored, extra key gone');
    assert.deepEqual(back.page.cookies, w1.page.cookies, 'cookies restored: changed one reset, deleted one back, stray one expired');
    assert.deepEqual(back.page.serviceWorkers, w1.page.serviceWorkers, 'the service worker is registered again');
    assert.equal(view(back), view(w1));

    // and back to the empty world: the worker is unregistered, cookies expire, sessionStorage clears
    await stage.relay.restoreWorld('default', w0);
    await sleep(300);
    const empty = await stage.world();
    assert.equal(view(empty), view(w0));
    assert.deepEqual(empty.page.serviceWorkers, []);
    assert.deepEqual(page.errors, [], page.errors.join('\n'));
  } finally { await stage.close(); }
});

test('a checkpoint carries coverage: what was captured, what cannot be', { skip: skip ?? false, timeout: 120000 }, async () => {
  const stage = await startStage('stores', { def: fixtureApp('stores') });
  try {
    const sid = await stage.client.startSession({});
    await stage.client.endSession(sid);
    const cp = (await stage.client.events(sid)).find((e) => e.kind === 'checkpoint');
    assert.deepEqual(cp.data.coverage.captured, ['localStorage', 'sessionStorage', 'cookies', 'serviceWorkers', 'indexedDB']);
    assert.ok(cp.data.coverage.notCaptured.some((x) => /HttpOnly/.test(x)) && cp.data.coverage.notCaptured.some((x) => /service-worker caches/.test(x)));
  } finally { await stage.close(); }
});

// ---- 3.4 ----
const autoinc = () => fixtureApp('autoinc', { volatileKeys: [] });
async function add(client, title) {
  await client.cmd('dom.fill', { selector: '#new', value: title });
  await client.cmd('dom.click', { selector: '#add' });
}
const rowsOf = (w) => w.page.indexedDB.app.stores.items.rows.map((r) => r.value.id);

test('an autoIncrement key generator that a restore cannot rewind is reported as drift, and the restored state says so', { skip: skip ?? false, timeout: 120000 }, async () => {
  const stage = await startStage('autoinc', { def: autoinc() });
  try {
    const { client } = stage;
    const sid = await client.startSession({ goal: 'autoinc' });
    await add(client, 'a'); await add(client, 'b'); await add(client, 'c');
    await client.cmd('dom.click', { selector: '.del', nth: 2 }); // rows 1,2 left, but the generator has already handed out 3
    const dropped = await stage.world();
    assert.deepEqual(rowsOf(dropped), [1, 2]);
    assert.equal(dropped.page.indexedDB.app.stores.items.keyGenerator, 4, 'the snapshot records the next key the store would issue');
    await add(client, 'd');
    assert.deepEqual(rowsOf(await stage.world()), [1, 2, 4], 'the original run got key 4');
    await client.endSession(sid);

    // the probe that reads the generator must not disturb it: capturing twice must not advance it
    assert.equal((await stage.world()).page.indexedDB.app.stores.items.keyGenerator, 5);
    assert.equal((await stage.world()).page.indexedDB.app.stores.items.keyGenerator, 5);

    const events = await client.events(sid);
    const from = events.find((e) => e.kind === 'command' && e.data.params.value === 'd').idx;
    const f = await client.fork(sid, { shadow: 'shadow', at: from });
    assert.deepEqual(f.restoreDrift, [{ db: 'app', store: 'items', expected: 4, actual: 3 }], 'rows 1,2 were put back, but the shadow store would issue 3, not 4');
    assert.equal(f.restoreVerified, false, 'the restored world is not the checkpointed one, and the fork says so');
    assert.deepEqual(rowsOf(await stage.world('shadow')), [1, 2, 3], 'the replayed add got a different key than the original run');
    assert.equal(f.finalState.same, false);
    const start = (await client.events(f.forkSession)).find((e) => e.kind === 'fork.start');
    assert.deepEqual(start.data.restore_drift, f.restoreDrift, 'the drift is written into the ledger');
    assert.ok((await client.verify(f.forkSession, true)).ok);
  } finally { await stage.close(); }
});

test('no drift and no false alarm when nothing was deleted: the restore reproduces the generator', { skip: skip ?? false, timeout: 120000 }, async () => {
  const stage = await startStage('autoinc', { def: autoinc() });
  try {
    const { client } = stage;
    const sid = await client.startSession({ goal: 'autoinc' });
    await add(client, 'a'); await add(client, 'b'); await add(client, 'c');
    await client.endSession(sid);
    const events = await client.events(sid);
    const from = events.filter((e) => e.kind === 'command' && e.data.params.value === 'c')[0].idx;
    const f = await client.fork(sid, { shadow: 'shadow', at: from });
    assert.deepEqual(f.restoreDrift, []);
    assert.equal(f.restoreVerified, true);
    assert.deepEqual(rowsOf(await stage.world('shadow')), [1, 2, 3]);
  } finally { await stage.close(); }
});
