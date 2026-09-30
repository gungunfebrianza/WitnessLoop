// The dashboard rendered in a REAL browser against a real bank story: every view draws without a
// script error, and hostile ledger content (a goal that is HTML) is shown as text, never executed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browserSkip, launchBrowser } from '../examples/lib/browser.mjs';
import { startStage } from '../examples/lib/stage.mjs';
import { stories } from '../examples/agents/stories.mjs';

const skip = browserSkip();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('dashboard renders every view for a real session and treats ledger text as text', { skip: skip ?? false, timeout: 120000 }, async () => {
  const stage = await startStage('bank');
  const viewer = await launchBrowser();
  try {
    const r = await stories.bank.story(stage);
    // hostile goal on a second session
    const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
    const sid2 = await stage.client.startSession({ goal: evil, actor: '<b>bold</b>' });
    await stage.client.endSession(sid2);

    await viewer.navigate(`http://127.0.0.1:${stage.relay.port}/dashboard`);
    const text = async (sel) => viewer.evaluate(`document.querySelector(${JSON.stringify(sel)})?.innerText ?? ''`);
    for (let i = 0; i < 150 && !/integrity across all sessions/i.test(await text('main')); i++) await sleep(100);

    const fleet = await text('main');
    assert.match(fleet, /agent comparison/i);
    assert.match(fleet, /policy rule hit map/i);
    assert.match(fleet, /overhead/i);
    assert.match(fleet, /chains verify/);

    // open the bank session and walk every tab
    await viewer.evaluate(`[...document.querySelectorAll('nav button.s')].find((b) => b.innerText.startsWith('#${r.sid} ')).click()`);
    const walk = async (label, expected) => {
      await viewer.evaluate(`(async () => { await new Promise((r) => setTimeout(r, 300)); [...document.querySelectorAll('.tabs button')].find((b) => b.innerText === ${JSON.stringify(label)}).click(); await new Promise((r) => setTimeout(r, 400)); })()`);
      const t = await text('main');
      assert.match(t, expected, `${label} view`);
      return t;
    };
    await walk('Integrity', /chain and seals verify/);
    await viewer.evaluate(`[...document.querySelectorAll('button.a')].find((b) => b.innerText === 'Flip one payload byte').click()`);
    await sleep(600);
    assert.match(await text('main'), /verifier detected it/);
    await walk('Money', /deviation from expected total/i);
    assert.ok(await viewer.evaluate('document.querySelectorAll("main svg rect").length > 10'), 'money tab draws stacked and deviation bars');
    assert.match(await text('main'), /off by -[0-9]+ cents/i);
    assert.match(await text('main'), /2 of 4 transfers flagged/i);
    await walk('Timeline', /session timeline/i);
    assert.ok(await viewer.evaluate('document.querySelectorAll("main svg circle").length > 10'), 'timeline draws event markers');
    assert.match(await text('main') + await viewer.evaluate('document.querySelector("main svg").innerHTML'), /first bad: #17/);
    await walk('Decision funnel', /policy: needs approval/);
    const incident = await walk('Incident', /money not conserved/);
    assert.match(incident, /reviewer-1|policy/);
    assert.ok(await viewer.evaluate('document.querySelectorAll(".strip .cell.bad").length > 0'));
    await walk('Causal graph', /inferred/);
    assert.ok(await viewer.evaluate('document.querySelectorAll("main svg path").length > 0'), 'causal arcs drawn');
    await walk('Forks', /compare/);
    await viewer.evaluate(`[...document.querySelectorAll('button.a')].find((b) => b.innerText === 'compare').click()`);
    await sleep(800);
    assert.match(await text('main'), /refused in the second session/);
    await walk('Policy what-if', /alternative policy/);

    assert.equal(await viewer.evaluate('window.__pwned'), undefined, 'hostile ledger text must not execute');
    assert.ok(!(await viewer.evaluate('document.body.innerHTML')).includes('<img src=x'), 'hostile text is not parsed as markup');
    // the hostile session is listed as literal text
    assert.ok(await viewer.evaluate(`[...document.querySelectorAll('nav button.s')].some((b) => b.innerText.includes('<img src=x'))`));
    assert.deepEqual(viewer.errors, [], viewer.errors.join('\n'));
  } finally {
    await viewer.close();
    await stage.close();
  }
});

// The same World tab, fed by each app's own profile.metrics: no bank-specific code in the page.
const worldCases = [
  ['mailer', 'Deliveries', /recipients outside the company/i, /off by \d+ recipients/i, /1 of \d+ messages flagged/i, /audit@evil\.example/],
  ['todo', 'Todos', /duplicate titles/i, /off by 1 items/i, /1 of \d+ todos flagged/i, /buy milk/],
];
for (const [app, tab, title, off, flagged, item] of worldCases) {
  test(`world tab for ${app} is drawn from its profile metrics`, { skip: skip ?? false, timeout: 120000 }, async () => {
    const stage = await startStage(app);
    const viewer = await launchBrowser();
    try {
      await stories[app].story(stage);
      await viewer.navigate(`http://127.0.0.1:${stage.relay.port}/dashboard`);
      const text = async () => viewer.evaluate(`document.querySelector('main')?.innerText ?? ''`);
      for (let i = 0; i < 150 && !/integrity across all sessions/i.test(await text()); i++) await sleep(100);
      await viewer.evaluate(`[...document.querySelectorAll('nav button.s')].find((b) => b.innerText.startsWith('#1 ')).click()`);
      await sleep(500);
      await viewer.evaluate(`[...document.querySelectorAll('.tabs button')].find((b) => b.innerText === ${JSON.stringify(tab)}).click()`);
      await sleep(400);
      const t = await text();
      assert.match(t, title);
      assert.match(t, off);
      assert.match(t, flagged);
      assert.match(t, item);
      assert.ok(await viewer.evaluate('document.querySelectorAll("main svg rect").length > 5'), 'bars drawn');
      assert.deepEqual(viewer.errors, [], viewer.errors.join('\n'));
    } finally {
      await viewer.close();
      await stage.close();
    }
  });
}
