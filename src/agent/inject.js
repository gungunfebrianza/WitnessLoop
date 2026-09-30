// witnessloop in-page agent. Include it in an app with
//   <script src="/witnessloop/inject.js"></script>
// It stays dormant unless the page was opened with ?witness=1 (remembered in localStorage), then
// connects to the local relay and answers commands. It never evals caller code.
(() => {
  'use strict';
  const qs = new URLSearchParams(location.search);
  try {
    if (qs.get('witness') === '1') localStorage.setItem('witness_enabled', '1');
    if (qs.get('witness') === '0') localStorage.removeItem('witness_enabled');
    if (qs.get('witness_port')) localStorage.setItem('witness_port', qs.get('witness_port'));
    if (qs.get('witness_name')) sessionStorage.setItem('witness_name', qs.get('witness_name'));
    // sessionStorage, not localStorage: the token is per tab and does not outlive it (any script on this page can still read it)
    if (qs.get('witness_token')) sessionStorage.setItem('witness_token', qs.get('witness_token'));
  } catch { /* storage blocked: stay dormant */ }
  let enabled = false;
  try { enabled = localStorage.getItem('witness_enabled') === '1'; } catch { /* dormant */ }
  if (!enabled || window.__witnessloop) return;

  const PORT = localStorage.getItem('witness_port') || '8974';
  const NAME = sessionStorage.getItem('witness_name') || 'default';
  const TOKEN = sessionStorage.getItem('witness_token') || '';
  const LOAD_ID = Math.random().toString(36).slice(2);
  const ADAPTER = !!document.querySelector('meta[name="witness-adapter"]');
  const EFFECTS = ['read', 'reversible', 'irreversible'];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__witnessloop = { name: NAME, loadId: LOAD_ID };

  // ---- track in-flight fetches so a click can wait for the app to finish reacting ----
  let inflight = 0;
  const realFetch = window.fetch.bind(window);
  window.fetch = (...args) => { note(() => fromFetch(args)); inflight++; return realFetch(...args).finally(() => { inflight--; }); };

  // ---- observe outgoing writes during a click (detection after the fact, never a block) ----
  // Only method, origin, path and a hash of the body are kept: no headers, query string, cookies or body text.
  // Not seen: WebSocket.send, requests after the click settles, and fetches a page captured before this script ran.
  let watching = null;
  const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
  const enc = new TextEncoder();
  async function bodyBytes(body) {
    if (body === undefined || body === null) return new Uint8Array(0);
    if (typeof body === 'string') return enc.encode(body);
    if (body instanceof URLSearchParams) return enc.encode(body.toString());
    if (body instanceof ArrayBuffer) return new Uint8Array(body);
    if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    if (typeof Blob !== 'undefined' && body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
    if (typeof FormData !== 'undefined' && body instanceof FormData) {
      return enc.encode(JSON.stringify([...body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `file:${v.name}:${v.size}`])));
    }
    return null;
  }
  async function hashBody(body) {
    try {
      if (!(window.crypto && crypto.subtle)) return null; // insecure context: no digest available
      const bytes = await bodyBytes(body);
      if (bytes === null) return null;
      return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch { return null; }
  }
  function record(method, url, body) {
    if (!watching) return;
    const m = String(method || 'GET').toUpperCase();
    if (SAFE.has(m)) return;
    let u;
    try { u = new URL(String(url), location.href); } catch { return; }
    watching.push(hashBody(body).then((body_hash) => ({ method: m, origin: u.origin, path: u.pathname, body_hash })));
  }
  const note = (fn) => { try { if (watching) fn(); } catch { /* observing must never break the page */ } };
  const fromFetch = ([input, init]) => record(init?.method ?? (input instanceof Request ? input.method : 'GET'), input instanceof Request ? input.url : input, init?.body);
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) { this.__wl = { method, url }; return xhrOpen.call(this, method, url, ...rest); };
  XMLHttpRequest.prototype.send = function (body) { note(() => this.__wl && record(this.__wl.method, this.__wl.url, body)); return xhrSend.call(this, body); };
  if (navigator.sendBeacon) {
    const beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => { note(() => record('POST', url, data)); return beacon(url, data); };
  }
  // A native submit that the page did not intercept navigates away, so the click's reply would be lost with the page:
  // push what we saw over the link now, before unload. A page that calls preventDefault and fetches is seen through fetch.
  let pushObserved = () => {};
  window.addEventListener('submit', (ev) => {
    if (!watching || ev.defaultPrevented) return;
    note(() => {
      const f = ev.target;
      const method = (ev.submitter?.getAttribute('formmethod') || f.getAttribute('method') || 'GET').toUpperCase();
      if (SAFE.has(method)) return;
      const action = ev.submitter?.getAttribute('formaction') || f.getAttribute('action') || location.href;
      const u = new URL(action, location.href);
      const eff = { method, origin: u.origin, path: u.pathname, body_hash: null };
      watching.push(Promise.resolve(eff));
      pushObserved([eff]);
    });
  });
  async function watchWhile(fn) {
    watching = [];
    try { return { value: await fn(), effects: await Promise.all(watching) }; } finally { watching = null; }
  }

  async function settle(maxMs = 3000) {
    const t0 = Date.now();
    let stable = 0;
    await sleep(20);
    while (Date.now() - t0 < maxMs) {
      if (inflight === 0) { if (++stable >= 3) return; } else stable = 0;
      await sleep(20);
    }
  }

  // ---- element resolution ----
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const preview = (el) => `<${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}> ${(el.textContent || '').trim().slice(0, 40)}`;
  function resolve(selector, nth) {
    if (!selector) throw new Error('selector is required');
    let list;
    try { list = [...document.querySelectorAll(selector)]; } catch { throw new Error(`invalid selector: ${selector}`); }
    if (!list.length) throw new Error(`no element matches ${selector}`);
    if (nth !== undefined && nth !== null) {
      if (!list[nth]) throw new Error(`nth ${nth} is out of range (${list.length} matches for ${selector})`);
      return list[nth];
    }
    if (list.length === 1) return list[0];
    const vis = list.filter(visible);
    if (vis.length === 1) return vis[0];
    throw new Error(`selector ${selector} is ambiguous: ${list.length} matches, pass nth. First: ${list.slice(0, 3).map(preview).join(' | ')}`);
  }

  // The page declares consequences: data-wl-effect="irreversible" (+ data-wl-preview="<css selector of
  // the form/container whose fields say what is about to happen>"). An unrecognised value fails closed.
  function collect(scope) {
    const out = {};
    if (!scope) return out;
    for (const f of scope.querySelectorAll('input,select,textarea')) {
      const key = f.name || f.id;
      if (!key) continue;
      if (f.type === 'radio' && !f.checked) continue;
      out[key] = f.type === 'checkbox' ? f.checked : f.value;
    }
    return out;
  }
  function describe(el) {
    const marked = el.closest('[data-wl-effect]');
    let effect = 'reversible';
    if (marked) { const v = marked.getAttribute('data-wl-effect'); effect = EFFECTS.includes(v) ? v : 'irreversible'; }
    // declared: what the page wrote (null = no annotation at all), so an unannotated click is distinguishable from an explicit reversible one
    const out = { effect, declared: marked ? marked.getAttribute('data-wl-effect') : null, tag: el.tagName.toLowerCase(), label: (el.textContent || el.value || el.getAttribute('aria-label') || el.id || '').trim().slice(0, 80) };
    if (marked && marked.hasAttribute('data-wl-preview')) {
      const sel = marked.getAttribute('data-wl-preview');
      out.preview = collect(sel ? document.querySelector(sel) : marked.closest('form'));
    }
    return out;
  }
  const brief = (el) => ({
    tag: el.tagName.toLowerCase(), id: el.id || undefined, name: el.getAttribute('name') || undefined, type: el.getAttribute('type') || undefined,
    value: 'value' in el && el.tagName !== 'BUTTON' && el.tagName !== 'LI' ? el.value : undefined,
    text: (el.innerText || el.textContent || '').trim().slice(0, 200), visible: visible(el),
    ...(el.checked !== undefined && el.type === 'checkbox' ? { checked: el.checked } : {}),
    ...(el.dataset && Object.keys(el.dataset).length ? { data: { ...el.dataset } } : {}),
  });

  // ---- world capture / restore: localStorage + every IndexedDB database ----
  const jsonSafe = (v) => JSON.parse(JSON.stringify(v ?? null));
  const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
  const idb = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

  async function dumpDb(name) {
    const db = await idb(indexedDB.open(name));
    try {
      const stores = {};
      const names = [...db.objectStoreNames];
      if (names.length) {
        const tx = db.transaction(names, 'readonly');
        for (const n of names) {
          const store = tx.objectStore(n);
          const rows = [];
          await new Promise((res, rej) => {
            const cur = store.openCursor();
            cur.onsuccess = () => { const c = cur.result; if (c) { rows.push({ key: jsonSafe(c.key), value: jsonSafe(c.value) }); c.continue(); } else res(); };
            cur.onerror = () => rej(cur.error);
          });
          stores[n] = {
            keyPath: store.keyPath, autoIncrement: store.autoIncrement, rows,
            indexes: [...store.indexNames].map((i) => { const ix = store.index(i); return { name: ix.name, keyPath: ix.keyPath, unique: ix.unique, multiEntry: ix.multiEntry }; }),
          };
        }
      }
      return { version: db.version, stores };
    } finally { db.close(); }
  }

  async function captureWorld() {
    const ls = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (!k.startsWith('witness')) ls[k] = localStorage.getItem(k); }
    const dbs = {};
    if (indexedDB.databases) for (const info of await indexedDB.databases()) if (info.name) dbs[info.name] = await dumpDb(info.name);
    return { url: location.href, localStorage: sortObj(ls), indexedDB: sortObj(dbs) };
  }

  async function restoreDb(name, snap) {
    let db = await idb(indexedDB.open(name));
    const missing = Object.keys(snap.stores).filter((s) => !db.objectStoreNames.contains(s));
    if (missing.length) {
      const version = db.version + 1;
      db.close();
      db = await new Promise((res, rej) => {
        const r = indexedDB.open(name, version);
        r.onupgradeneeded = () => {
          for (const s of missing) {
            const def = snap.stores[s];
            const st = r.result.createObjectStore(s, { keyPath: def.keyPath ?? undefined, autoIncrement: def.autoIncrement });
            for (const ix of def.indexes || []) st.createIndex(ix.name, ix.keyPath, { unique: ix.unique, multiEntry: ix.multiEntry });
          }
        };
        r.onblocked = () => rej(new Error(`upgrading ${name} is blocked by another open connection`));
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    }
    try {
      const names = [...db.objectStoreNames];
      if (!names.length) return;
      const tx = db.transaction(names, 'readwrite');
      const done = new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
      for (const n of names) {
        const store = tx.objectStore(n);
        store.clear();
        for (const row of snap.stores[n]?.rows || []) { if (store.keyPath !== null) store.put(row.value); else store.put(row.value, row.key); }
      }
      await done;
    } finally { db.close(); }
  }

  async function restoreWorld(world) {
    for (const k of Object.keys(localStorage)) if (!k.startsWith('witness')) localStorage.removeItem(k);
    for (const [k, v] of Object.entries(world.localStorage || {})) localStorage.setItem(k, v);
    const existing = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name).filter(Boolean) : [];
    for (const name of new Set([...existing, ...Object.keys(world.indexedDB || {})])) {
      await restoreDb(name, world.indexedDB?.[name] || { stores: {} });
    }
    // IndexedDB cannot rewind an autoIncrement key generator, so a replay may hand out different keys
    const warnings = [];
    for (const [db, snap] of Object.entries(world.indexedDB || {})) {
      for (const [store, def] of Object.entries(snap.stores || {})) if (def.autoIncrement) warnings.push(`${db}/${store} is autoIncrement: keys assigned after a restore may differ from the original run`);
    }
    return { restored: true, reloading: true, warnings };
  }

  // ---- command handlers: keep in step with src/registry.mjs (a test enforces it) ----
  const handlers = {
    'ping': () => ({ pong: true, name: NAME, loadId: LOAD_ID }),
    // paths, not full urls: a shadow copy of the app lives on another origin, and replays must compare equal
    'page.info': () => ({ path: location.pathname + location.hash, title: document.title }),
    'dom.query': ({ selector, limit = 20 }) => {
      if (!selector) throw new Error('selector is required');
      const list = [...document.querySelectorAll(selector)];
      return { matchCount: list.length, items: list.slice(0, limit).map(brief) };
    },
    'dom.describe': ({ selector, nth }) => describe(resolve(selector, nth)),
    'dom.text': ({ selector, nth }) => { const el = resolve(selector, nth); return { text: (el.innerText || el.textContent || '').trim().slice(0, 5000) }; },
    'dom.wait': async ({ selector, text, gone = false, timeoutMs = 5000 }) => {
      const t0 = Date.now();
      const found = () => (selector
        ? [...document.querySelectorAll(selector)].some((el) => !text || (el.innerText || el.textContent || '').includes(text))
        : (document.body.innerText || '').includes(text));
      while (Date.now() - t0 < timeoutMs) { if (found() !== gone) return { waitedMs: Date.now() - t0 }; await sleep(50); }
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${gone ? 'absence of ' : ''}${selector || text}`);
    },
    'dom.click': async ({ selector, nth }) => {
      const el = resolve(selector, nth);
      if (el.disabled) throw new Error(`${selector} is disabled`);
      const before = location.pathname + location.hash;
      const { effects } = await watchWhile(async () => { el.click(); await settle(); });
      const after = location.pathname + location.hash;
      return { clicked: true, tag: el.tagName.toLowerCase(), pathBefore: before, path: after, navigated: after !== before, observed_effects: effects };
    },
    'dom.fill': async ({ selector, nth, value }) => {
      const el = resolve(selector, nth);
      const tag = el.tagName;
      if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') throw new Error(`${selector} is not a fillable field`);
      if (tag === 'SELECT' && ![...el.options].some((o) => o.value === String(value) || o.text === String(value))) throw new Error(`no option "${value}" in ${selector}`);
      const proto = tag === 'INPUT' ? HTMLInputElement.prototype : tag === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLSelectElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(value));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      await settle();
      return { filled: true, value: el.value };
    },
    'page.reload': () => ({ reloading: true }),
    'world.capture': () => captureWorld(),
    'world.restore': ({ world }) => restoreWorld(world),
  };

  // ---- connection ----
  let backoff = 500;
  function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/agent?name=${encodeURIComponent(NAME)}&loadId=${LOAD_ID}&origin=${encodeURIComponent(location.origin)}&adapter=${ADAPTER ? 1 : 0}&token=${encodeURIComponent(TOKEN)}`);
    ws.onopen = () => { backoff = 500; pushObserved = (effects) => { try { ws.send(JSON.stringify({ kind: 'observed', effects })); } catch { /* link down */ } }; };
    ws.onmessage = async (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.kind !== 'command') return;
      try {
        const h = handlers[msg.type];
        if (!h) throw new Error(`unknown command ${msg.type}`);
        const result = await h(msg.params || {});
        ws.send(JSON.stringify({ kind: 'reply', id: msg.id, ok: true, result }));
        if (result && result.reloading) setTimeout(() => location.reload(), 30);
      } catch (e) {
        ws.send(JSON.stringify({ kind: 'reply', id: msg.id, ok: false, error: String((e && e.message) || e) }));
      }
    };
    ws.onclose = () => { setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 8000); };
    ws.onerror = () => { try { ws.close(); } catch { /* already closed */ } };
  }
  // Announce the page only once it has loaded and its own startup fetches have settled: a caller that waits for the agent
  // (a restore-and-reload in a fork, a fresh session) then reads a rendered page, not a half-built one.
  // A page whose load event never comes (a hung image) still connects after 5s.
  let started = false;
  const start = () => { if (started) return; started = true; settle().then(connect); };
  if (document.readyState === 'complete') start(); else { window.addEventListener('load', start, { once: true }); setTimeout(start, 5000); }
})();
