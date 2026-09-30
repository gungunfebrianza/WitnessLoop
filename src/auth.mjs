// Relay authentication: one bearer token per relay process. Without it any local process (or any web page
// that can reach 127.0.0.1) could approve an irreversible action, replace the policy or drive the browser.
// The token is a shared secret between the relay and its clients: it authenticates the caller to the relay,
// it does not say which person is behind the caller (approvals are separately signed, see attest.mjs).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

export const DEFAULT_TOKEN_FILE = path.join('.witnessloop', 'token');

export const newToken = () => crypto.randomBytes(32).toString('hex');

// Constant-time: compare digests so neither length nor content of the secret leaks through timing.
export function tokenMatches(expected, presented) {
  if (typeof expected !== 'string' || typeof presented !== 'string' || !expected) return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(presented).digest();
  return crypto.timingSafeEqual(a, b);
}

export const bearerOf = (header) => { const m = /^Bearer (.+)$/.exec(header ?? ''); return m ? m[1] : null; };

// Write the token so only the current user can read it. POSIX: mode 0600. Windows ignores the mode, so remove
// inherited ACL entries and grant only this user with icacls. If that cannot be done the caller must not start
// serving with a token that other local users can read: this throws and the relay does not start.
export function writeTokenFile(file, token, { platform = process.platform, run = execFileSync, user = os.userInfo().username } = {}) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, token, { mode: 0o600 });
  if (platform === 'win32') {
    try {
      run('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], { stdio: 'ignore', windowsHide: true });
    } catch (e) {
      try { fs.rmSync(file, { force: true }); } catch { /* best effort: do not leave a readable token behind */ }
      throw new Error(`could not restrict ${file} to the current user (icacls failed: ${e.message}); refusing to start with a token other users may read`);
    }
  } else {
    fs.chmodSync(file, 0o600); // the mode above is not applied to a file that already existed
  }
  return file;
}

// Where a client finds the token: explicit value, then WITNESSLOOP_TOKEN, then the token file.
export function resolveToken({ token, env = process.env, file } = {}) {
  if (token) return token;
  if (env.WITNESSLOOP_TOKEN) return env.WITNESSLOOP_TOKEN;
  try { return fs.readFileSync(file ?? env.WITNESSLOOP_TOKEN_FILE ?? DEFAULT_TOKEN_FILE, 'utf8').trim() || null; } catch { return null; }
}
