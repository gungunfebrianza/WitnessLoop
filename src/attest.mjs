// ed25519 attestation. A "seal" is a signature over a session's chain head; anyone holding the
// bundle and the public key can check it offline. The key is local: see docs/THREAT-MODEL.md for
// what that does and does not prove.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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

export const fingerprint = (publicKeyB64) => crypto.createHash('sha256').update(Buffer.from(publicKeyB64, 'base64')).digest('hex').slice(0, 16);

export function signMessage(privateKeyB64, message) {
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64, 'base64'), format: 'der', type: 'pkcs8' });
  return crypto.sign(null, Buffer.from(message), key).toString('base64');
}

export function verifySignature(publicKeyB64, message, sigB64) {
  try {
    const key = crypto.createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    return crypto.verify(null, Buffer.from(message), key, Buffer.from(sigB64, 'base64'));
  } catch {
    return false;
  }
}
