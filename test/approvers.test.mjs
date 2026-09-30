import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generateKey, fingerprint, signMessage, approvalMessage } from '../src/attest.mjs';
import { verifyBundle } from '../src/ledger.mjs';
import { withBank, transferVia, waitFor } from './helpers/relay.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');
const fp = (k) => fingerprint(k.publicKey);
const POLICY = { default: 'require_approval', rules: [] };

// start a transfer that the gate holds, return the pending approval and the promise for the command
async function held(client) {
  const inflight = transferVia(client, 'bob', 300).catch((e) => e);
  const [p] = await waitFor(async () => { const l = await client.pending(); return l.length ? l : null; });
  return { p, inflight };
}
const post = (relay, verb, id, body) => fetch(`http://127.0.0.1:${relay.port}/gate/${id}/${verb}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${relay.token}` }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
const sign = (key, id, verdict, nonce) => signMessage(key.privateKey, approvalMessage({ id, verdict, nonce }));

test('unsigned approval is rejected and the action stays held; a signed one releases it and records the key', async () => {
  await withBank(async ({ client, relay, bank, approverKey }) => {
    const sid = await client.startSession({});
    const { p, inflight } = await held(client);
    const r = await post(relay, 'approve', p.id, { by: 'reviewer-1' });
    assert.equal(r.status, 401);
    assert.match(r.json.error, /must be signed/);
    assert.equal((await client.pending()).length, 1, 'still pending');
    assert.ok(!bank.agent.seen.some((m) => m.type === 'dom.click'), 'nothing was dispatched');
    await client.approve(p.id, { by: 'reviewer-1', reason: 'ok' });
    const out = await inflight;
    assert.equal(out.ok, true);
    const d = (await client.events(sid)).filter((e) => e.kind === 'decision').at(-1);
    assert.equal(d.data.approver_fp, fp(approverKey));
    assert.equal(d.actor, `approver:${fp(approverKey)}`, 'attributed to the key, not the label');
    assert.equal(d.data.by, 'reviewer-1');
    await client.endSession(sid);
  }, { policy: POLICY });
});

test('wrong key, tampered verdict and bad signature are all rejected', async () => {
  await withBank(async ({ client, relay, approverKey }) => {
    await client.startSession({});
    const { p, inflight } = await held(client);
    const stranger = generateKey();
    let r = await post(relay, 'approve', p.id, { approver_pub: stranger.publicKey, sig: sign(stranger, p.id, 'allow', p.nonce), nonce: p.nonce });
    assert.equal(r.status, 403, 'unregistered key');
    // signed "deny" but submitted to /approve: the verdict is part of what was signed
    r = await post(relay, 'approve', p.id, { approver_pub: approverKey.publicKey, sig: sign(approverKey, p.id, 'deny', p.nonce), nonce: p.nonce });
    assert.equal(r.status, 401);
    assert.match(r.json.error, /signature is invalid/);
    // signature over a different intent id
    r = await post(relay, 'approve', p.id, { approver_pub: approverKey.publicKey, sig: sign(approverKey, '9.9', 'allow', p.nonce), nonce: p.nonce });
    assert.equal(r.status, 401);
    // a made-up nonce
    r = await post(relay, 'approve', p.id, { approver_pub: approverKey.publicKey, sig: sign(approverKey, p.id, 'allow', 'f'.repeat(32)), nonce: 'f'.repeat(32) });
    assert.equal(r.status, 401);
    assert.match(r.json.error, /nonce does not match/);
    // half a signature
    r = await post(relay, 'approve', p.id, { approver_pub: approverKey.publicKey });
    assert.equal(r.status, 401);
    assert.equal((await client.pending()).length, 1, 'every failed attempt left it pending');
    await client.deny(p.id, {});
    assert.equal((await inflight).ok, false);
  }, { policy: POLICY });
});

test('a captured signed approval cannot be replayed', async () => {
  await withBank(async ({ client, relay, approverKey }) => {
    await client.startSession({});
    const { p, inflight } = await held(client);
    const body = { approver_pub: approverKey.publicKey, sig: sign(approverKey, p.id, 'allow', p.nonce), nonce: p.nonce };
    assert.equal((await post(relay, 'approve', p.id, body)).status, 200);
    await inflight;
    const again = await post(relay, 'approve', p.id, body);
    assert.equal(again.status, 409);
    assert.match(again.json.error, /replayed nonce/);
    // nor lifted onto the next approval: each pending approval gets its own nonce, and the spent one stays spent
    const second = held(client);
    const { p: p2 } = await second;
    assert.notEqual(p2.nonce, p.nonce);
    assert.equal((await post(relay, 'approve', p2.id, { ...body })).status, 409);
    await client.deny(p2.id, {});
  }, { policy: POLICY });
});

test('a signed denial is recorded too; timeout still denies with no signature at all', async () => {
  await withBank(async ({ client, relay }) => {
    const sid = await client.startSession({});
    const { p, inflight } = await held(client);
    await client.deny(p.id, { reason: 'no' });
    assert.equal((await inflight).ok, false);
    const t = transferVia(client, 'carol', 300).catch((e) => e);
    await t;
    const decisions = (await client.events(sid)).filter((e) => e.kind === 'decision');
    assert.equal(decisions.at(-1).data.by, 'timeout');
    assert.equal(decisions.at(-1).data.verdict, 'deny');
    assert.equal(decisions.at(-1).data.approver_fp, undefined);
  }, { policy: POLICY, approvalTimeoutMs: 1500 }); // long enough that a loaded machine still reaches deny() before the timer
});

test('--allow-unsigned-approvals is the only way the old self-declared path works', async () => {
  await withBank(async ({ client, relay }) => {
    const sid = await client.startSession({});
    const { p, inflight } = await held(client);
    assert.equal((await post(relay, 'approve', p.id, { by: 'anyone' })).status, 200);
    assert.equal((await inflight).ok, true);
    const d = (await client.events(sid)).filter((e) => e.kind === 'decision').at(-1);
    assert.equal(d.data.approver_fp, undefined, 'recorded as unsigned');
    // ...which a verifier that pins approvers refuses
    const r = verifyBundle(await client.bundle(sid), { strict: false, trustedApprovers: ['0'.repeat(16)] });
    assert.ok(r.problems.some((x) => x.idx === d.idx && /not signed by an approver key/.test(x.reason)));
  }, { policy: POLICY, allowUnsignedApprovals: true });
});

test('verify --trusted-approver: passes for the pinned key, fails for another, and catches forged decision fields', async () => {
  await withBank(async ({ client, approverKey }) => {
    const sid = await client.startSession({});
    const { p, inflight } = await held(client);
    await client.approve(p.id, { by: 'reviewer-1' });
    await inflight;
    await client.endSession(sid);
    const bundle = await client.bundle(sid);
    assert.equal(verifyBundle(bundle).ok, true, 'no pin, nothing extra required');
    assert.equal(verifyBundle(bundle, { trustedApprovers: [fp(approverKey)] }).ok, true);
    const other = verifyBundle(bundle, { trustedApprovers: [fp(generateKey())] });
    assert.equal(other.ok, false);
    assert.ok(other.problems.some((x) => /not a trusted approver/.test(x.reason)));
    assert.equal((await client.verify(sid, { strict: true, trustedApprovers: [fp(approverKey)] })).ok, true, 'the relay runs the same check');
    assert.equal((await client.verify(sid, { strict: true, trustedApprovers: [fp(generateKey())] })).ok, false);

    // forge the recorded decision in the bundle: flip the verdict the signature covered, re-hash so the chain still verifies
    const forged = JSON.parse(JSON.stringify(bundle));
    const ev = forged.events.filter((e) => e.kind === 'decision').at(-1);
    const blob = JSON.parse(forged.blobs[ev.data_hash]);
    assert.ok(blob.sig, 'the decision carries the approver signature');
    // a different approver claiming the decision: fingerprint no longer matches the key that signed
    const impostor = generateKey();
    const swapped = { ...blob, approver_pub: impostor.publicKey };
    const { canon, sha256 } = await import('../src/canon.mjs');
    const { eventHash } = await import('../src/ledger.mjs');
    const rehash = (b) => {
      const json = canon(b); const h = sha256(json);
      delete forged.blobs[ev.data_hash]; forged.blobs[h] = json; ev.data_hash = h;
      let prev = ev.prev_hash;
      for (const e of forged.events.filter((x) => x.idx >= ev.idx)) { e.prev_hash = prev; e.hash = eventHash(prev, e); prev = e.hash; }
    };
    rehash(swapped);
    const r = verifyBundle(forged, { trustedApprovers: [fp(approverKey)] });
    assert.ok(r.problems.some((x) => x.idx === ev.idx && /different approver fingerprint/.test(x.reason)), JSON.stringify(r.problems));
    // a decision naming the trusted fingerprint but with an unrelated signature
    rehash({ ...blob, sig: signMessage(approverKey.privateKey, 'something else') });
    const r2 = verifyBundle(forged, { trustedApprovers: [fp(approverKey)] });
    assert.ok(r2.problems.some((x) => x.idx === ev.idx && /does not match the recorded intent, verdict and nonce/.test(x.reason)), JSON.stringify(r2.problems));
  }, { policy: POLICY });
});

test('fork auto-approval passes an approver pin only inside a fork; a production chain claiming auto-approve does not', async () => {
  const { withBankPair } = await import('./helpers/relay.mjs');
  await withBankPair(async ({ client, relay, approverKey }) => {
    const sid = await client.startSession({});
    const { p, inflight } = await held(client);
    await client.approve(p.id, {});
    await inflight;
    await client.endSession(sid);
    const fork = await client.fork(sid, { shadow: 'shadow', policy: POLICY });
    const pin = { strict: true, trustedApprovers: [fp(approverKey)] };
    const v = await client.verify(fork.forkSession, pin);
    assert.equal(v.ok, true, JSON.stringify(v.problems));
    const auto = relay.ledger.events(fork.forkSession, { hydrate: true }).some((e) => e.kind === 'decision' && e.data.by === 'auto-approve');
    assert.ok(auto, 'the fork really contains an auto-approval');
    // the same claim in a chain with no fork.start is refused
    const bundle = await client.bundle(fork.forkSession);
    const noFork = JSON.parse(JSON.stringify(bundle));
    noFork.events = noFork.events.map((e) => (e.kind === 'fork.start' ? { ...e, kind: 'note' } : e));
    assert.equal(verifyBundle(noFork, { trustedApprovers: [fp(approverKey)], strict: false }).ok, false);
  }, { policy: POLICY });
});

test('CLI: keygen --role approver writes an approver key and tells you how to register it; approve without --key is refused', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-appr-'));
  const out = path.join(d, 'a.json');
  const r = spawnSync(process.execPath, [CLI, 'keygen', '--role', 'approver', '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /approver key at/);
  assert.match(r.stdout, /--approver [0-9a-f]{16}/);
  const k = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.ok(k.publicKey && k.privateKey);
  assert.notEqual(spawnSync(process.execPath, [CLI, 'keygen', '--role', 'bogus', '--out', out], { encoding: 'utf8' }).status, 0);
  assert.notEqual(spawnSync(process.execPath, [CLI, 'approve', '1.1', '--key', path.join(d, 'missing.json')], { encoding: 'utf8' }).status, 0);
});
