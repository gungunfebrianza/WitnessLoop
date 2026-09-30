// End to end in a REAL browser: the in-page agent, the example apps, the gate, checkpoints,
// fork and replay. Skipped when no Chromium/Edge/Chrome is installed (WITNESSLOOP_REQUIRE_BROWSER=1
// turns the skip into a failure).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { browserSkip, launchBrowser } from '../examples/lib/browser.mjs';
import { createRelay } from '../src/relay.mjs';
import { createClient } from '../src/client.mjs';
import { startStage } from '../examples/lib/stage.mjs';
import { stories } from '../examples/agents/stories.mjs';
import { COMMANDS } from '../src/registry.mjs';

const skip = browserSkip();
const opts = { skip: skip ?? false, timeout: 120000 };

test('inject.js implements exactly the commands the registry declares (no drift, no eval)', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'agent', 'inject.js'), 'utf8');
  const block = src.slice(src.indexOf('const handlers = {'), src.indexOf('// ---- connection'));
  const found = [...block.matchAll(/^\s{4}'([a-z.]+)':/gm)].map((m) => m[1]).sort();
  assert.deepEqual(found, Object.keys(COMMANDS).sort());
  assert.ok(!/\beval\s*\(|new Function/.test(src), 'the agent never evals caller code');
});

test('bank story: gate, bisect, patched-boundary fork, compare, offline proof', opts, async () => {
  const stage = await startStage('bank');
  try {
    const r = await stories.bank.story(stage);
    assert.ok(r.verified.ok);
    assert.match(r.bisect.firstBad.why, /money not conserved/);
    assert.equal(r.bisect.firstBad.command.params.selector, '#send');
    assert.equal(r.fork.restoreVerified, true);
    assert.equal(r.fork.steps.filter((s) => s.denied).length, 2);
    assert.notEqual(r.prodTotal, r.initialTotal, 'production leaked a cent');
    assert.equal(r.shadowTotal, r.initialTotal, 'the patched fork conserves money');
    assert.equal(r.compare.firstDivergence.reason, 'refused in the second session', JSON.stringify(r.compare.firstDivergence));
    assert.ok(r.proof.okBefore && r.proof.tamperDetected);

    const events = await stage.client.events(r.sid);
    const intents = events.filter((e) => e.kind === 'intent');
    assert.equal(intents.length, 6, 'every irreversible click was gated');
    const byAmount = (a) => events.filter((e) => e.kind === 'decision' && e.data.intent_idx === intents.find((i) => i.data.preview.amount === a).idx);
    assert.equal(byAmount('100').at(-1).data.verdict, 'allow');
    assert.equal(byAmount('999999').at(-1).data.verdict, 'deny');
    const human = byAmount('300').at(-1);
    assert.equal(human.data.by, 'reviewer-1', 'the $300 payment needed and got a human');
    assert.match(human.actor, /^approver:[0-9a-f]{16}$/, 'and the decision is attributed to the approver key, not the label');
    assert.equal(human.actor, `approver:${human.data.approver_fp}`);
    const clicksRan = events.filter((e) => e.kind === 'command' && e.type === 'dom.click').length;
    assert.equal(clicksRan, 4, 'the two refused $999999 sends never reached the page');
    assert.deepEqual(stage.prod.browser.errors, []);
  } finally { await stage.close(); }
});

test('mailer story: hidden BCC is flagged, wrong recipient refused, leak reproduces in the shadow', opts, async () => {
  const stage = await startStage('mailer');
  try {
    const r = await stories.mailer.story(stage);
    assert.equal(r.flags.length, 1);
    assert.match(r.flags[0].data.why, /audit@evil\.example/);
    assert.equal(r.refused, 1, 'the external send was refused by the human');
    assert.match(r.bisect.firstBad.why, /audit@evil\.example/);
    assert.equal(r.replay.reproduced, true, JSON.stringify(r.replay.firstDivergence ?? r.replay.finalState.diff));
    assert.equal(r.leaked, false, 'skipping the invoice send removes the leak in the counterfactual');
    const prod = (await stage.world('default')).server.outbox;
    assert.equal(prod.length, 2);
    assert.ok(prod.some((m) => m.bcc.includes('audit@evil.example')));
    assert.ok(!prod.some((m) => m.to.includes('sam.leigh@rival.example')), 'nothing went to the wrong Sam');
    assert.ok(r.proof.okBefore && r.proof.tamperDetected);
  } finally { await stage.close(); }
});

test('todo story: no gate, exact replay of pure page state, fork changes only the shadow', opts, async () => {
  const stage = await startStage('todo');
  try {
    const r = await stories.todo.story(stage);
    assert.equal(r.intents, 0);
    assert.equal(r.replay.reproduced, true, JSON.stringify(r.replay.firstDivergence ?? r.replay.finalState.diff));
    assert.match(r.bisect.firstBad.why, /duplicate todo titles/);
    assert.equal(r.parentBefore, r.parentAfter, 'production untouched by the fork');
    assert.equal(r.shadowRows.length, r.parentAfter - 1, 'the fork skipped the duplicate add');
    assert.ok(r.proof.okBefore && r.proof.tamperDetected);
  } finally { await stage.close(); }
});

test('page annotations fail closed: an unrecognised data-wl-effect is treated as irreversible', opts, async () => {
  const stage = await startStage('bank');
  try {
    await stage.prod.browser.evaluate(`document.getElementById('send').setAttribute('data-wl-effect', 'catastrophic')`);
    const d = await stage.relay.dispatch('default', 'dom.describe', { selector: '#send' });
    assert.equal(d.effect, 'irreversible');
    const plain = await stage.relay.dispatch('default', 'dom.describe', { selector: '#amount' });
    assert.equal(plain.effect, 'reversible');
    assert.equal(d.preview.to, '');
    await assert.rejects(stage.relay.dispatch('default', 'dom.click', { selector: 'button.nope' }), /no element matches/);
    await assert.rejects(stage.relay.dispatch('default', 'dom.fill', { selector: '#to', value: 'mallory' }), /no option/);
  } finally { await stage.close(); }
});

test('shop story: an unannotated Pay button is not stopped, but the write is flagged live and detected offline (after the fact)', opts, async () => {
  const stage = await startStage('shop');
  try {
    const r = await stories.shop.story(stage);
    assert.equal(r.paid.ok, true, 'the click ran: detection, not prevention');
    assert.equal(r.intents, 0, 'the gate never saw it');
    assert.equal(r.balance, 5100, 'and the money moved');
    assert.equal(r.flags.length, 1);
    assert.equal(r.flags[0].type, 'undeclared_effect');
    assert.equal(r.flags[0].data.declared, null);
    const [ev] = r.flags[0].data.evidence;
    assert.deepEqual([ev.method, ev.path], ['POST', '/api/pay']);
    assert.match(ev.body_hash ?? '', /^[0-9a-f]{64}$/, 'a body hash, never the body');
    assert.deepEqual(r.detected.detections.map((d) => d.kind).sort(), ['observed_request', 'server_state_changed']);
    assert.match(r.detected.note, /not prevention/);
    assert.ok(r.proof.okBefore && r.proof.tamperDetected);
  } finally { await stage.close(); }
});

test('the agent announces a page only after its own startup fetches have settled, so a caller never reads a half-built page', opts, async () => {
  const inject = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'agent', 'inject.js'));
  const page = '<!doctype html><title>slow</title><p id="ready"></p><script src="/witnessloop/inject.js"></script>'
    + '<script>fetch("/slow").then((r) => r.text()).then((t) => { document.getElementById("ready").textContent = t; });</script>';
  const server = http.createServer((req, res) => {
    if (req.url === '/witnessloop/inject.js') { res.writeHead(200, { 'content-type': 'text/javascript' }).end(inject); return; }
    if (req.url === '/slow') { setTimeout(() => res.writeHead(200, { 'content-type': 'text/plain' }).end('rendered'), 600); return; }
    res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const relay = await createRelay({ port: 0, policy: { default: 'allow', rules: [] } });
  await relay.listen();
  const client = createClient({ port: relay.port, token: relay.token });
  const browser = await launchBrowser();
  try {
    await browser.navigate(`http://127.0.0.1:${server.address().port}/?witness=1&witness_port=${relay.port}&witness_name=default&witness_token=${relay.token}`);
    for (let i = 0; i < 100 && !(await client.health()).agents.includes('default'); i++) await new Promise((r) => setTimeout(r, 50));
    const sid = await client.startSession({});
    const out = await client.cmd('dom.text', { selector: '#ready' });
    assert.equal(out.result.text, 'rendered', 'the first read after the agent appears already sees the fetched content');
    await client.endSession(sid);
  } finally {
    await browser.close(); await relay.close(); server.closeAllConnections?.(); await new Promise((r) => server.close(r));
    await new Promise((r) => setTimeout(r, 100));
  }
});
