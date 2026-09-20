// Canonical JSON (sorted keys, no whitespace, undefined dropped) so the same value always
// hashes the same. Everything witnessloop hashes or signs goes through canon().
import crypto from 'node:crypto';

export function canon(v) {
  if (v === undefined || typeof v === 'function' || typeof v === 'symbol') return 'null';
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) return 'null';
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  const keys = Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== 'function').sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hashOf = (v) => sha256(canon(v));

// Remove volatile keys (timestamps, random ids) anywhere in a value, so two runs that differ
// only in those fields compare equal. Used for replay comparison, never for the ledger itself.
export function stripKeys(v, keys) {
  if (!keys || !keys.length) return v;
  const drop = new Set(keys);
  const walk = (x) => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') {
      const out = {};
      for (const [k, val] of Object.entries(x)) if (!drop.has(k)) out[k] = walk(val);
      return out;
    }
    return x;
  };
  return walk(v);
}

export function getPath(obj, path) {
  let cur = obj;
  for (const part of String(path).split('.')) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

export function setPath(obj, path, value) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}
