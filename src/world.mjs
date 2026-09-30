// The "world" an agent acts on = page storage (localStorage, sessionStorage, document.cookie, service-worker
// registrations, IndexedDB) + the app server's own state, which an app exposes through adapter.mjs.
// A checkpoint is a content-addressed copy of it. What a snapshot cannot hold is listed in `page.meta.notCaptured`.
import { hashOf, stripKeys } from './canon.mjs';

// What two worlds are compared on. The page url is excluded (a shadow instance has another port)
// and so is anything an app declares volatile (timestamps, random ids). Stores an older snapshot lacks compare as empty.
export function comparable(world, volatileKeys = []) {
  return stripKeys({
    localStorage: world?.page?.localStorage ?? {},
    sessionStorage: world?.page?.sessionStorage ?? {},
    cookies: world?.page?.cookies ?? {},
    serviceWorkers: world?.page?.serviceWorkers ?? [],
    indexedDB: world?.page?.indexedDB ?? {},
    server: world?.server ?? null,
  }, volatileKeys);
}

export const REDACTED = '[redacted]';

// Replace the value of every key (storage key, cookie name, object field, at any depth) named in `keys`, case-insensitively.
// Applied where a snapshot is written to a blob, so a secret never reaches the ledger or an exported bundle. Returns { world, count }.
export function redactWorld(world, keys = []) {
  if (!keys.length) return { world, count: 0 };
  const names = new Set(keys.map((k) => k.toLowerCase()));
  let count = 0;
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (names.has(k.toLowerCase())) { out[k] = REDACTED; count++; } else out[k] = walk(x);
      }
      return out;
    }
    return v;
  };
  return { world: walk(world), count };
}

export function validateRedactKeys(keys) {
  if (keys === undefined) return [];
  if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string' || !k)) throw new Error('profile.redactKeys must be an array of non-empty strings');
  return keys;
}

export const stateHash = (world, volatileKeys = []) => hashOf(comparable(world, volatileKeys));

export function diffWorld(a, b, limit = 200) {
  const out = [];
  const walk = (x, y, path) => {
    if (out.length >= limit) return;
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    const xo = x && typeof x === 'object';
    const yo = y && typeof y === 'object';
    if (xo && yo && Array.isArray(x) === Array.isArray(y)) {
      const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
      for (const k of [...keys].sort()) walk(x[k], y[k], path ? `${path}.${k}` : k);
      return;
    }
    out.push({ path, before: x, after: y });
  };
  walk(a, b, '');
  return out;
}

async function httpJson(url, init) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${url} -> ${res.status}`);
  return res.json();
}

// `relay` supplies dispatch(agent, type, params), agentInfo(agent), waitForReconnect(agent, loadId).
export async function captureWorld(relay, agent) {
  const info = relay.agentInfo(agent);
  if (!info) throw new Error(`agent "${agent}" is not connected`);
  const page = await relay.dispatch(agent, 'world.capture', {});
  const server = info.adapter ? await httpJson(`${info.origin}/__witness/state`) : null;
  return { page, server };
}

export async function restoreWorld(relay, agent, world) {
  const info = relay.agentInfo(agent);
  if (!info) throw new Error(`agent "${agent}" is not connected`);
  if (info.adapter && world.server !== null && world.server !== undefined) {
    await httpJson(`${info.origin}/__witness/restore`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(world.server) });
  }
  const reply = await relay.dispatch(agent, 'world.restore', { world: world.page });
  if (reply?.reloading) await relay.waitForReconnect(agent, info.loadId);
  return { drift: Array.isArray(reply?.drift) ? reply.drift : [] };
}
