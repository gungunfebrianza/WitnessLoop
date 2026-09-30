// ed25519 attestation. A "seal" is a signature over a session's chain head; anyone holding the
// bundle and the public key can check it offline. The key is local: see docs/THREAT-MODEL.md for
// what that does and does not prove.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { canon } from './canon.mjs';

export function generateKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

export function loadOrCreateKey(file) {
  try {
    const k = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (k.publicKey && k.privateKey) return k;
  } catch { /* fall through and create */ }
  const k = generateKey();
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(k, null, 2), { mode: 0o600 });
  return k;
}

// Persist a key (and the certs that led to it) so a rotation survives a restart.
export function saveKey(file, key) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(key, null, 2), { mode: 0o600 });
}

// Read an existing key file; unlike loadOrCreateKey it never creates one (an approver key must be issued on purpose).
export function readKey(file) {
  const k = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!k.publicKey || !k.privateKey) throw new Error(`${file} is not a witnessloop key file`);
  return k;
}

// What an approver signs: this intent, this verdict, this one-time nonce. Nothing else can be replayed onto it.
export const approvalMessage = (a) => canon({ kind: 'approval', id: a.id, verdict: a.verdict, nonce: a.nonce });

export const fingerprint = (publicKeyB64) => crypto.createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('hex').slice(0, 16);

export function signMessage(privateKeyB64, message) {
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  return crypto.sign(null, Buffer.from(message), key).toString('base64');
}

// A rotation cert: the OLD key vouches for the NEW public key. A verifier that trusts the old key can
// therefore follow the chain of certs to the new one. The kind tag keeps a cert signature from being
// replayed as any other signed statement.
export const certMessage = (c) => canon({ kind: 'key.rotate', old_pub: c.old_pub, new_pub: c.new_pub, ts: c.ts });
export function keyCert(oldKey, newPublicKey, ts) {
  const c = { old_pub: oldKey.publicKey, new_pub: newPublicKey, ts };
  return { ...c, sig: signMessage(oldKey.privateKey, certMessage(c)) };
}
export const verifyCert = (c) => !!c && typeof c.old_pub === 'string' && typeof c.new_pub === 'string' && verifySignature(c.old_pub, certMessage(c), c.sig);

// A revocation: a key that is still trusted declares another key (by fingerprint) no longer trusted for
// anything sealed after the revoke event in a chain.
export const revokeMessage = (r) => canon({ kind: 'key.revoke', fingerprint: r.fingerprint, ts: r.ts });
export function makeRevocation(key, revokedFingerprint, ts) {
  const r = { fingerprint: revokedFingerprint, ts };
  return { ...r, revoker_pub: key.publicKey, sig: signMessage(key.privateKey, revokeMessage(r)) };
}
export const verifyRevocation = (r) => !!r && typeof r.revoker_pub === 'string' && typeof r.fingerprint === 'string' && verifySignature(r.revoker_pub, revokeMessage(r), r.sig);

export function verifySignature(publicKeyB64, message, sigB64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(message), key, Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}
