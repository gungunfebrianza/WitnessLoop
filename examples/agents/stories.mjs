// Scripted "agents" and the accountable-autonomy story for each example app. A story runs a
// deliberately imperfect agent, then uses witnessloop to find what went wrong, fork the past under
// a patched boundary, and prove the record. `say` narrates; tests pass a no-op.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { verifyBundle } from '../../src/ledger.mjs';
import { readPolicy } from '../lib/stage.mjs';

const noop = () => {};

// A human reviewer: approves or refuses whatever the gate is holding.
function startReviewer(client, decide, by = 'reviewer') {
  let stop = false;
  const loop = (async () => {
    while (!stop) {
      for (const p of await client.pending().catch(() => [])) {
        const d = decide(p);
        await (d.allow ? client.approve(p.id, { by, reason: d.reason }) : client.deny(p.id, { by, reason: d.reason })).catch(() => {});
      }
      await new Promise((r) => setTimeout(r, 60));
    }
  })();
  return { stop: async () => { stop = true; await loop; } };
}

async function tamperCheck(client, sid) {
  const bundle = await client.bundle(sid);
  const okBefore = verifyBundle(bundle).ok;
  const victim = bundle.events.find((e) => e.kind === 'command' && e.data_hash && /"selector"/.test(bundle.blobs[e.data_hash] ?? ''));
  const forged = JSON.parse(JSON.stringify(bundle));
  forged.blobs[victim.data_hash] = forged.blobs[victim.data_hash].replace('"selector"', '"selectoR"');
  const after = verifyBundle(forged);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-story-'));
  const file = path.join(dir, `session-${sid}.wl.json`);
  fs.writeFileSync(file, JSON.stringify(bundle));
  return { okBefore, tamperDetected: !after.ok && after.badIdx === victim.idx, tamperedIdx: victim.idx, file };
}

// ---------------------------------------------------------------------------- bank
export const bank = {
  async sloppyAgent(client) {
    const to = async (who, amount) => {
      await client.cmd('dom.fill', { selector: '#to', value: who }, { actor: 'sloppy-agent' });
      await client.cmd('dom.fill', { selector: '#amount', value: String(amount) }, { actor: 'sloppy-agent' });
      return client.cmd('dom.click', { selector: '#send' }, { actor: 'sloppy-agent' });
    };
    const sid = await client.startSession({ goal: 'Pay the team', actor: 'sloppy-agent' });
    await client.cmd('dom.query', { selector: '#balances tbody tr' }, { actor: 'sloppy-agent' });
    await to('bob', '100');
    await to('carol', '33.33');
    await to('bob', '999999');
    await to('bob', '999999');
    await to('bob', '1.00');
    await to('carol', '300');
    await client.endSession(sid);
    return sid;
  },

  async story(stage, say = noop) {
    const { client } = stage;
    say('1. A sloppy agent pays people. Small payments to known payees pass by policy; the $300 one waits for a human; $999999 is over the hard limit.');
    const reviewer = startReviewer(client, (p) => ({ allow: Number(p.preview.amount) <= 500, reason: 'within my authority' }), 'reviewer-1');
    const sid = await bank.sloppyAgent(client);
    await reviewer.stop();
    const verified = await client.verify(sid, true);
    say(`2. Ledger chain verified: ${verified.ok} (${verified.checked} events, sealed through #${verified.sealedThrough}).`);

    const bisect = await client.bisect(sid);
    say(`3. bisect: first bad event is #${bisect.firstBad.commandIdx} (${JSON.stringify(bisect.firstBad.preview ?? bisect.firstBad.command.params)}) - ${bisect.firstBad.why}; approved by ${bisect.firstBad.approvedBy}.`);

    const prodWorld = await stage.world('default');
    const patched = readPolicy('bank-patched.json');
    const fork = await client.fork(sid, { shadow: 'shadow', policy: patched });
    const shadowWorld = await stage.world('shadow');
    const refused = fork.steps.filter((s) => s.denied).length;
    say(`4. fork onto the SHADOW app under a patched boundary: ${refused} step(s) refused; production untouched.`);
    const { INITIAL_TOTAL, totalMoney } = await import('../bank/model.mjs');
    say(`   production total ${totalMoney(prodWorld.server)} vs shadow total ${totalMoney(shadowWorld.server)} (must be ${INITIAL_TOTAL}).`);

    const compare = await client.compare(sid, fork.forkSession);
    say(`5. compare: first divergence at attempt ${compare.firstDivergence.position}: ${compare.firstDivergence.reason}.`);

    const proof = await tamperCheck(client, sid);
    say(`6. exported bundle verifies offline: ${proof.okBefore}; flipping one payload byte at event #${proof.tamperedIdx} is caught: ${proof.tamperDetected}.`);
    return { sid, verified, bisect, fork, compare, proof, prodTotal: totalMoney(prodWorld.server), shadowTotal: totalMoney(shadowWorld.server), initialTotal: INITIAL_TOTAL };
  },
};

// ---------------------------------------------------------------------------- mailer
export const mailer = {
  async sloppyAgent(client) {
    const mail = async (toAddr, subject) => {
      await client.cmd('dom.fill', { selector: '#to', value: toAddr }, { actor: 'sloppy-agent' });
      await client.cmd('dom.fill', { selector: '#subject', value: subject }, { actor: 'sloppy-agent' });
      return client.cmd('dom.click', { selector: '#send' }, { actor: 'sloppy-agent' });
    };
    const sid = await client.startSession({ goal: 'Tell Sam the contract is ready, and send Dana the invoice', actor: 'sloppy-agent' });
    const contacts = await client.cmd('dom.query', { selector: '#contacts li' }, { actor: 'sloppy-agent' });
    // two people are called Sam; the agent takes the LAST match, which is the wrong one
    const sams = contacts.result.items.filter((i) => /Sam/.test(i.text));
    const wrongSam = sams.at(-1).data.email;
    await mail('priya@acme.test', 'Weekly status');
    await mail('dana@acme.test', 'Invoice 42 attached');
    await mail(wrongSam, 'Contract is ready');
    await client.endSession(sid);
    return sid;
  },

  async story(stage, say = noop) {
    const { client } = stage;
    say('1. An agent mails people. Internal recipients pass by policy; an external one waits for a human, who refuses.');
    const reviewer = startReviewer(client, (p) => ({ allow: false, reason: `${p.preview.to} is outside the company` }), 'reviewer-2');
    const sid = await mailer.sloppyAgent(client);
    await reviewer.stop();
    const events = await client.events(sid);
    const flags = events.filter((e) => e.kind === 'flag');
    say(`2. The gate flagged ${flags.length} effect mismatch: ${flags[0]?.data.why}.`);
    const refused = events.filter((e) => e.kind === 'decision' && e.data.verdict === 'deny').length;
    say(`3. ${refused} send(s) were refused before anything left: the wrong Sam never got the contract.`);

    const bisect = await client.bisect(sid);
    say(`4. bisect: the invariant first broke at event #${bisect.firstBad.commandIdx}: ${bisect.firstBad.why}.`);
    const replay = await client.replayVerify(sid, { shadow: 'shadow' });
    say(`5. replay-verify on the shadow app: reproduced=${replay.reproduced} - the leak is deterministic, not a fluke.`);
    const invoiceSend = events.find((e) => e.kind === 'command' && e.idx === bisect.firstBad.commandIdx);
    const fork = await client.fork(sid, { shadow: 'shadow', skip: [invoiceSend.idx] });
    const shadowWorld = await stage.world('shadow');
    const leaked = shadowWorld.server.outbox.some((m) => m.bcc.length);
    say(`6. counterfactual: skip that one send in a fork -> leak in the fork's outbox: ${leaked}.`);
    const proof = await tamperCheck(client, sid);
    say(`7. bundle verifies offline: ${proof.okBefore}; tamper caught: ${proof.tamperDetected}.`);
    return { sid, flags, refused, bisect, replay, fork, leaked, proof };
  },
};

// ---------------------------------------------------------------------------- todo
export const todo = {
  async agent(client) {
    const add = async (title) => {
      await client.cmd('dom.fill', { selector: '#new', value: title }, { actor: 'todo-agent' });
      await client.cmd('dom.click', { selector: '#add' }, { actor: 'todo-agent' });
    };
    const sid = await client.startSession({ goal: 'Plan the day', actor: 'todo-agent' });
    await add('buy milk');
    await add('walk dog');
    await client.cmd('dom.click', { selector: '.toggle', nth: 0 }, { actor: 'todo-agent' });
    await add('buy milk'); // duplicate: breaks the profile's invariant
    await client.cmd('dom.click', { selector: '.del', nth: 1 }, { actor: 'todo-agent' });
    await client.endSession(sid);
    return sid;
  },

  async story(stage, say = noop) {
    const { client } = stage;
    say('1. An agent edits a todo list. Nothing here is irreversible, so the gate never fires and no human is asked.');
    const sid = await todo.agent(client);
    const events = await client.events(sid);
    const intents = events.filter((e) => e.kind === 'intent').length;
    say(`2. intents recorded: ${intents}. World checkpoints hold pure page state (IndexedDB).`);
    const replay = await client.replayVerify(sid, { shadow: 'shadow' });
    say(`3. replay-verify on a shadow tab: reproduced=${replay.reproduced} across ${replay.steps} steps (volatile "created" timestamps normalised).`);
    const bisect = await client.bisect(sid);
    say(`4. bisect: invariant first broke at event #${bisect.firstBad.commandIdx}: ${bisect.firstBad.why}.`);
    const dupAdd = events.filter((e) => e.kind === 'command' && e.type === 'dom.click' && e.data.params.selector === '#add')[2];
    const parentBefore = (await stage.world('default')).page.indexedDB['todo-db'].stores.todos.rows.length;
    const fork = await client.fork(sid, { shadow: 'shadow', skip: [dupAdd.idx] });
    const shadowRows = (await stage.world('shadow')).page.indexedDB['todo-db'].stores.todos.rows;
    const parentAfter = (await stage.world('default')).page.indexedDB['todo-db'].stores.todos.rows.length;
    say(`5. fork skipping the duplicate add: shadow has ${shadowRows.length} todos, production still ${parentAfter} (was ${parentBefore}).`);
    const proof = await tamperCheck(client, sid);
    say(`6. bundle verifies offline: ${proof.okBefore}; tamper caught: ${proof.tamperDetected}.`);
    return { sid, intents, replay, bisect, fork, shadowRows, parentBefore, parentAfter, proof };
  },
};

export const stories = { bank, mailer, todo };
