import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKey, fingerprint, keyCert, makeRevocation } from '../src/attest.mjs';
import { Ledger, verifyBundle } from '../src/ledger.mjs';
import { mcpOps, findOp } from '../src/ops.mjs';
import { withBank, transferVia } from './helpers/relay.mjs';

const cmd = (l, sid, i) => l.append(sid, { kind: 'command', type: 'dom.click', effect: 'reversible', ok: true, data: { params: { i }, result: {} } });
const fp = (k) => fingerprint(k.publicKey);
const clone = (x) => JSON.parse(JSON.stringify(x));

test('a session sealed across a rotation verifies from the OLD pinned key, and the chain shows the handover', () => {
  const A = generateKey(); const B = generateKey();
  const l = new Ledger(':memory:', { key: A });
  const sid = l.startSession({});
  cmd(l, sid, 1); cmd(l, sid, 2);
  l.rotateKey(B);
  cmd(l, sid, 3);
  l.endSession(sid);
  const b = l.bundle(sid);
  assert.ok(b.events.some((e) => e.kind === 'key.rotate'), 'the rotation is a chain event');
  const r = verifyBundle(b, { trustedKeys: [fp(A)] });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  assert.deepEqual(new Set(r.signers), new Set([fp(A), fp(B)]), 'both keys sealed this session');
  // pinning only the NEW key does not vouch for what the old key sealed: trust flows forward from the pin
  const fromNew = verifyBundle(b, { trustedKeys: [fp(B)] });
  assert.equal(fromNew.ok, false);
  assert.ok(fromNew.problems.some((p) => /untrusted key/.test(p.reason)));
  // the in-chain cert alone is enough: the handover does not depend on the bundle-level list
  assert.equal(verifyBundle({ ...clone(b), rotations: [] }, { trustedKeys: [fp(A)] }).ok, true);
});

test('a session started AFTER the rotation verifies from the old pin only through the certs the bundle carries', () => {
  const A = generateKey(); const B = generateKey();
  const l = new Ledger(':memory:', { key: A });
  l.rotateKey(B);
  const sid = l.startSession({});
  cmd(l, sid, 1);
  l.endSession(sid);
  const b = l.bundle(sid);
  assert.equal(b.rotations.length, 1);
  assert.deepEqual(verifyBundle(b, { trustedKeys: [fp(A)] }).signers, [fp(B)]);
  assert.equal(verifyBundle(b, { trustedKeys: [fp(A)] }).ok, true);
  const stripped = verifyBundle({ ...clone(b), rotations: [] }, { trustedKeys: [fp(A)] });
  assert.equal(stripped.ok, false, 'without the cert nothing links the old pin to the new signer');
  assert.ok(stripped.problems.some((p) => /untrusted key/.test(p.reason)));
  assert.equal(verifyBundle(clone(b)).ok, true, 'an unpinned verify is unchanged');
});

test('forged certs do not extend trust: wrong signer, and a self-vouching attacker key', () => {
  const A = generateKey(); const X = generateKey(); const X2 = generateKey();
  const evil = new Ledger(':memory:', { key: X });
  const sid = evil.startSession({});
  cmd(evil, sid, 1);
  evil.endSession(sid);
  const b = evil.bundle(sid);
  // claims A vouched for X, but the signature is X's own
  const forged = { ...keyCert(X, X.publicKey, new Date().toISOString()), old_pub: A.publicKey };
  assert.equal(verifyBundle({ ...clone(b), rotations: [forged] }, { trustedKeys: [fp(A)] }).ok, false);
  // X vouches for X2: a valid cert, but from a key nobody trusted, so it never joins A's trust set
  const selfCert = keyCert(X, X2.publicKey, new Date().toISOString());
  assert.equal(verifyBundle({ ...clone(b), rotations: [selfCert] }, { trustedKeys: [fp(A)] }).ok, false);
  assert.equal(verifyBundle(clone(b), { trustedKeys: [fp(A)] }).ok, false, 'and no certs at all');
});

test('a key revoked at event R loses every seal after R, keeps the ones before, and only a trusted key can revoke', () => {
  const A = generateKey(); const B = generateKey();
  const l = new Ledger(':memory:', { key: A });
  const sid = l.startSession({});
  cmd(l, sid, 1);
  l.rotateKey(B);
  const { revocation } = l.revokeKey(fp(A));
  assert.equal(revocation.fingerprint, fp(A));
  cmd(l, sid, 2);
  l.endSession(sid);
  const R = l.events(sid).find((e) => e.kind === 'key.revoke').idx;
  const ok = verifyBundle(l.bundle(sid), { trustedKeys: [fp(A)] });
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));

  // a thief with the revoked key seals the head after the revocation
  l.key = A;
  cmd(l, sid, 99);
  l.seal(sid);
  const bad = verifyBundle(l.bundle(sid), { trustedKeys: [fp(A)], strict: false });
  assert.equal(bad.ok, false);
  const revoked = bad.problems.filter((p) => /revoked/.test(p.reason));
  assert.equal(revoked.length, 1);
  assert.ok(revoked[0].idx > R, 'only the seal after the revocation is rejected');
  assert.match(revoked[0].reason, new RegExp(`revoked at event #${R}`));
});

test('a key.revoke from an untrusted key is reported, never silently honoured or ignored', () => {
  const A = generateKey(); const B = generateKey(); const Z = generateKey();
  const l = new Ledger(':memory:', { key: A });
  const sid = l.startSession({});
  l.append(sid, { kind: 'key.revoke', actor: 'relay', data: makeRevocation(Z, fp(A), new Date().toISOString()) });
  l.endSession(sid);
  const r = verifyBundle(l.bundle(sid), { trustedKeys: [fp(A)] });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /key\.revoke signed by a key that is not trusted/.test(p.reason)));
  // and a revoke with a broken signature
  const l2 = new Ledger(':memory:', { key: A });
  const s2 = l2.startSession({});
  l2.append(s2, { kind: 'key.revoke', actor: 'relay', data: { ...makeRevocation(A, fp(B), new Date().toISOString()), fingerprint: fp(A) } });
  l2.endSession(s2);
  assert.ok(verifyBundle(l2.bundle(s2), { trustedKeys: [fp(A)] }).problems.some((p) => /key\.revoke signature invalid/.test(p.reason)));
});

test('the current signing key cannot be revoked', () => {
  const A = generateKey();
  const l = new Ledger(':memory:', { key: A });
  assert.throws(() => l.revokeKey(fp(A)), /rotate first/);
});

test('relay: rotate-key persists the new key, the active session records the handover, revoke works, and a restart keeps the certs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-keys-'));
  const keyPath = path.join(dir, 'key.json');
  const dbPath = path.join(dir, 'ledger.db');
  let oldFp; let newFp; let sid;
  await withBank(async ({ client, relay }) => {
    oldFp = fp(relay.ledger.key);
    sid = await client.startSession({});
    await transferVia(client, 'bob', 5);
    const rot = await client.rotateKey();
    newFp = rot.fingerprint;
    assert.equal(rot.previous, oldFp);
    assert.notEqual(newFp, oldFp);
    assert.equal(fp(JSON.parse(fs.readFileSync(keyPath, 'utf8'))), newFp, 'the key file already holds the new key');
    await transferVia(client, 'bob', 6);
    await client.revokeKey(oldFp);
    await assert.rejects(client.revokeKey(newFp), /rotate first/);
    await assert.rejects(client.revokeKey('nope'), /16-hex/);
    await client.endSession(sid);
    const v = await client.verify(sid, { strict: true, trustedKeys: [oldFp] });
    assert.equal(v.ok, true, JSON.stringify(v.problems));
    const kinds = (await client.events(sid)).map((e) => e.kind);
    assert.ok(kinds.includes('key.rotate') && kinds.includes('key.revoke'));
  }, { policy: { default: 'allow' }, keyPath, dbPath });
  // restart on the same files: the ledger still knows the cert and the key file still holds the new key
  const l = new Ledger(dbPath, { key: JSON.parse(fs.readFileSync(keyPath, 'utf8')) });
  assert.equal(l.rotations().length, 1);
  assert.equal(verifyBundle(l.bundle(sid), { trustedKeys: [oldFp] }).ok, true);
  l.close();
});

test('key lifecycle ops are in the shared op table, so the CLI and the MCP tool expose the same actions', () => {
  assert.ok(findOp('rotate-key') && findOp('revoke-key'));
  const mcp = mcpOps().map((o) => o.name);
  for (const n of ['rotate-key', 'revoke-key', 'anchor']) assert.ok(mcp.includes(n), n);
});

test('a corrupt or incomplete key file stops the start instead of being silently replaced; only a missing file creates a key', async () => {
  const { loadOrCreateKey } = await import('../src/attest.mjs');
  const { createRelay } = await import('../src/relay.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-key-'));
  const file = path.join(d, 'key.json');
  const made = loadOrCreateKey(file);
  assert.deepEqual(loadOrCreateKey(file), made, 'an existing good key is reused');
  for (const bad of ['{not json', '{}', '{"publicKey":"x"}', '']) {
    fs.writeFileSync(file, bad);
    assert.throws(() => loadOrCreateKey(file), /refusing to replace|corrupt/, JSON.stringify(bad));
    assert.equal(fs.readFileSync(file, 'utf8'), bad, 'the bad file is left untouched');
    await assert.rejects(createRelay({ port: 0, keyPath: file }), /refusing to replace|corrupt/);
  }
  fs.rmSync(file);
  assert.ok(loadOrCreateKey(file).publicKey, 'missing file: a new key is created');
});
