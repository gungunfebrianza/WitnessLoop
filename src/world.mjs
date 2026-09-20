// The "world" an agent acts on = page storage (localStorage + IndexedDB) + the app server's own
// state, which an app exposes through adapter.mjs. A checkpoint is a content-addressed copy of it.
import { hashOf, stripKeys } from './canon.mjs';

// What two worlds are compared on. The page url is excluded (a shadow instance has another port)
// and so is anything an app declares volatile (timestamps, random ids).
export function comparable(world, volatileKeys = []) {
  return stripKeys({
    localStorage: world?.page?.localStorage ?? {},
    indexedDB: world?.page?.indexedDB ?? {},
    server: world?.server ?? null,
  }, volatileKeys);
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
}
