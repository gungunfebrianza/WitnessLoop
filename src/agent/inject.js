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

  // ---- nondeterminism: recorded in production (opt-in), controlled in a shadow copy ----
  // Armed only by the relay: a shadow replay arms it (`shim.arm`, remembered per tab so a reload keeps it and this block, running before the
  // page's own scripts, can install it first); a production session records what the page drew during each command (`shim.record`).
  // Untouched otherwise. Not covered: draws outside a command window, references saved before this ran, performance.now, crypto.getRandomValues.
  const nativeDate = window.Date;
  const nativeRandom = Math.random.bind(Math);
  const nowNative = () => nativeDate.now();
  const ND_CAP = 500;
  const nd = { mode: 'off', seed: 0, base: 0, ticks: 0, rand: null, installed: false, active: false, feed: { now: [], random: [] }, fed: { now: 0, random: 0 }, used: { now: 0, random: 0 }, rec: { now: [], random: [], truncated: false } };
  const mulberry32 = (a) => () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  function draw(kind) {
    if (nd.mode === 'replay') {
      if (nd.active) nd.used[kind]++;
      if (nd.active && nd.feed[kind].length) return nd.feed[kind].shift();
      return kind === 'now' ? nd.base + nd.ticks++ : nd.rand(); // nothing recorded for this draw: a seeded stand-in, reported as such
    }
    const v = kind === 'now' ? nowNative() : nativeRandom();
    if (nd.mode === 'record' && nd.active) { if (nd.rec[kind].length < ND_CAP) nd.rec[kind].push(v); else nd.rec.truncated = true; }
    return v;
  }
  function installShims() {
    if (nd.installed) return;
    nd.installed = true;
    window.Date = new Proxy(nativeDate, {
      construct: (t, args, nt) => Reflect.construct(t, args.length ? args : [draw('now')], nt),
      apply: () => new nativeDate(draw('now')).toString(),
      get: (t, p, r) => (p === 'now' ? () => draw('now') : Reflect.get(t, p, r)),
    });
    Math.random = () => draw('random');
  }
  function armReplay(seed, base) { nd.mode = 'replay'; nd.seed = seed >>> 0; nd.base = Number(base) || 0; nd.ticks = 0; nd.rand = mulberry32(nd.seed); installShims(); }
  try {
    const armed = sessionStorage.getItem('witness_shim');
    if (armed) { const a = JSON.parse(armed); armReplay(a.seed, a.base); } else if (sessionStorage.getItem('witness_shim_rec') === '1') { nd.mode = 'record'; installShims(); }
  } catch { /* storage blocked: no shims */ }
  const beginDraws = () => { ext.active = true; nd.active = true; nd.used = { now: 0, random: 0 }; nd.fed = { now: nd.feed.now.length, random: nd.feed.random.length }; nd.rec = { now: [], random: [], truncated: false }; };
  const endDraws = () => {
    nd.active = false;
    if (nd.mode === 'record' && (nd.rec.now.length || nd.rec.random.length)) return { now: nd.rec.now, random: nd.rec.random, ...(nd.rec.truncated ? { truncated: true } : {}) };
    if (nd.mode === 'replay') {
      nd.feed = { now: [], random: [] }; // whatever this command did not consume is not carried into the next one
      if (nd.used.now || nd.used.random || nd.fed.now || nd.fed.random) return { used: { ...nd.used }, fed: { ...nd.fed } };
    }
    return null;
  };

  // ---- third-party responses: recorded in production, served from the recording in a shadow copy (opt-in, named origins only) ----
  // record: fetches to a named foreign origin made during a command are kept (status, type, body up to a cap; no request headers, no query string, only its hash).
  // replay: a fetch to such an origin is answered from the recording. With no matching recording it FAILS, and the network is never reached.
  // XHR and sendBeacon to those origins are blocked in replay. Not covered: anything but fetch when recording, requests made outside a command window.
  const EXT_CAP = 256 * 1024;
  const ext = { mode: 'off', origins: new Set(), active: false, pending: [], feed: [], served: 0, missed: [] };
  function armExternal(mode, origins) {
    ext.mode = mode === 'record' || mode === 'replay' ? mode : 'off';
    ext.origins = new Set(ext.mode === 'off' ? [] : (Array.isArray(origins) ? origins.filter((o) => typeof o === 'string') : []));
    ext.feed = []; ext.served = 0; ext.missed = []; ext.pending = [];
    try { if (ext.mode === 'off') sessionStorage.removeItem('witness_ext'); else sessionStorage.setItem('witness_ext', JSON.stringify({ mode: ext.mode, origins: [...ext.origins] })); } catch { /* per-tab memory only */ }
  }
  try { const s = sessionStorage.getItem('witness_ext'); if (s) { const c = JSON.parse(s); armExternal(c.mode, c.origins); } } catch { /* storage blocked: no external handling */ }
  const b64 = (buf) => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const foreign = (url) => { if (ext.mode === 'off') return null; try { const u = new URL(String(url), location.href); return ext.origins.has(u.origin) && u.origin !== location.origin ? u : null; } catch { return null; } };
  const blocked = (method, u) => { ext.missed.push({ method: String(method || 'GET').toUpperCase(), origin: u.origin, path: u.pathname, reason: 'not fetch: blocked in replay' }); return new Error(`witnessloop: ${u.origin} is served from a recording during replay; only fetch can be, so this request was blocked`); };
  const externalKey = async (method, u, body) => ({ method, origin: u.origin, path: u.pathname, query_hash: await hashBody(u.search), req_hash: await hashBody(body) });
  async function serveExternal(method, u, body) {
    const key = await externalKey(method, u, body);
    const i = ext.feed.findIndex((c) => c.method === key.method && c.origin === key.origin && c.path === key.path && c.query_hash === key.query_hash && c.req_hash === key.req_hash);
    const c = i < 0 ? null : ext.feed[i];
    if (!c || typeof c.body_b64 !== 'string') {
      ext.missed.push({ ...key, reason: c ? 'the recording was truncated' : 'no recorded response' });
      throw new TypeError(`witnessloop: no recorded response for ${key.method} ${key.origin}${key.path}; the network was not used`);
    }
    ext.feed.splice(i, 1); ext.served++;
    return new Response([101, 204, 205, 304].includes(c.status) ? null : unb64(c.body_b64), { status: c.status, headers: c.content_type ? { 'content-type': c.content_type } : {} });
  }
  function recordExternal(method, u, body, p) {
    ext.pending.push(p.then(async (res) => {
      const buf = await res.clone().arrayBuffer();
      const entry = { ...(await externalKey(method, u, body)), status: res.status, content_type: res.headers.get('content-type'), bytes: buf.byteLength };
      if (buf.byteLength <= EXT_CAP) entry.body_b64 = b64(buf); else entry.truncated = true;
      return entry;
    }, () => null)); // a failed fetch records nothing
  }
  async function endExternal() {
    ext.active = false;
    if (ext.mode === 'record') { const list = (await Promise.all(ext.pending)).filter(Boolean); ext.pending = []; return list.length ? { external: list } : null; }
    if (ext.mode === 'replay') {
      const r = { served: ext.served, missed: ext.missed, unused: ext.feed.length };
      ext.served = 0; ext.missed = []; ext.feed = [];
      return r.served || r.missed.length || r.unused ? { external_replay: r } : null;
    }
    return null;
  }

  // ---- value flow: which strings this agent served in a read, and whether a later fill typed one back ----
  // Only exact equality with a string this agent itself returned in the same page load. That is an observed fact about the page; it is not
  // proof that the read caused the fill (a coincidence, or a value the caller already knew, looks the same). The relay records it as-is.
  const FLOW_READS = new Set(['dom.query', 'dom.text', 'dom.describe']);
  const served = new Map();
  let replySeq = 0;
  function remember(v, seq, budget = { n: 2000 }) {
    if (budget.n <= 0 || v === null || v === undefined) return;
    if (typeof v === 'string') { if (v.length >= 3) { served.set(v, seq); budget.n--; } return; }
    if (Array.isArray(v)) { for (const x of v) remember(x, seq, budget); return; }
    if (typeof v === 'object') for (const x of Object.values(v)) remember(x, seq, budget);
  }

  const PORT = localStorage.getItem('witness_port') || '8974';
  const NAME = sessionStorage.getItem('witness_name') || 'default';
  const TOKEN = sessionStorage.getItem('witness_token') || '';
  const LOAD_ID = nativeRandom().toString(36).slice(2);
  const ADAPTER = !!document.querySelector('meta[name="witness-adapter"]');
  const EFFECTS = ['read', 'reversible', 'irreversible'];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__witnessloop = { name: NAME, loadId: LOAD_ID };

  // ---- track in-flight fetches so a click can wait for the app to finish reacting ----
  let inflight = 0;
  const realFetch = window.fetch.bind(window);
  window.fetch = (...args) => {
    note(() => fromFetch(args));
    const [input, init] = args;
    const u = foreign(input instanceof Request ? input.url : input);
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (u && ext.mode === 'replay') return serveExternal(method, u, init?.body);
    inflight++;
    const p = realFetch(...args);
    if (u && ext.mode === 'record' && ext.active) recordExternal(method, u, init?.body, p);
    return p.finally(() => { inflight--; });
  };

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
  XMLHttpRequest.prototype.open = function (method, url, ...rest) { const fu = ext.mode === 'replay' ? foreign(url) : null; if (fu) throw blocked(method, fu); this.__wl = { method, url }; return xhrOpen.call(this, method, url, ...rest); };
  XMLHttpRequest.prototype.send = function (body) { note(() => this.__wl && record(this.__wl.method, this.__wl.url, body)); return xhrSend.call(this, body); };
  if (navigator.sendBeacon) {
    const beacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = (url, data) => { const fu = ext.mode === 'replay' ? foreign(url) : null; if (fu) { blocked('POST', fu); return false; } note(() => record('POST', url, data)); return beacon(url, data); };
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
    const t0 = nowNative();
    let stable = 0;
    await sleep(20);
    while (nowNative() - t0 < maxMs) {
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

  // ---- world capture / restore: localStorage, sessionStorage, document.cookie, service-worker registrations, every IndexedDB database ----
  const jsonSafe = (v) => JSON.parse(JSON.stringify(v ?? null));
  const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
  const idb = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
  // what a snapshot cannot hold, written into every checkpoint so nobody has to guess
  const NOT_CAPTURED = [
    'HttpOnly cookies (document.cookie cannot read them)', 'cookies whose path does not cover this page',
    'service-worker caches and worker-internal state (registration state only)', 'Cache Storage', 'WebSocket and other live connections',
    'in-memory JavaScript state', 'storage of other origins and frames',
  ];
  const isOurs = (k) => k.startsWith('witness');
  const readCookies = () => {
    const out = {};
    for (const part of document.cookie.split(';')) {
      const p = part.trim();
      if (!p) continue;
      const i = p.indexOf('=');
      const k = i < 0 ? p : p.slice(0, i);
      if (!isOurs(k)) out[k] = i < 0 ? '' : p.slice(i + 1);
    }
    return out;
  };
  // paths, not urls: a shadow copy of the app lives on another origin and must compare equal
  const pathOf = (u) => { try { return new URL(u, location.href).pathname; } catch { return String(u); } };
  async function readServiceWorkers() {
    if (!navigator.serviceWorker || !navigator.serviceWorker.getRegistrations) return [];
    const out = [];
    for (const r of await navigator.serviceWorker.getRegistrations()) {
      const w = r.active || r.waiting || r.installing;
      out.push({ scope: pathOf(r.scope), script: w ? pathOf(w.scriptURL) : null, state: r.active ? r.active.state : (r.waiting ? 'waiting' : 'installing') });
    }
    return out.sort((a, b) => (a.scope < b.scope ? -1 : 1));
  }
  // The next key an autoIncrement store would hand out, read by adding a row inside a transaction that is then aborted:
  // an abort rewinds the generator, so this leaves the store as it was. null = could not probe.
  function probeGenerator(db, name) {
    return new Promise((res) => {
      let key = null;
      let tx;
      try {
        tx = db.transaction(name, 'readwrite');
        const st = tx.objectStore(name);
        const req = st.keyPath !== null ? st.add({}) : st.add(0);
        req.onsuccess = () => { key = req.result; tx.abort(); };
        req.onerror = (e) => { e.preventDefault(); try { tx.abort(); } catch { /* done */ } };
      } catch { try { tx?.abort(); } catch { /* done */ } res(null); return; }
      tx.onabort = () => res(typeof key === 'number' ? key : null);
      tx.oncomplete = () => res(null);
    });
  }

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
      for (const n of names) if (stores[n].autoIncrement) stores[n].keyGenerator = await probeGenerator(db, n);
      return { version: db.version, stores };
    } finally { db.close(); }
  }

  async function captureWorld() {
    const ls = {};
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (!isOurs(k)) ls[k] = localStorage.getItem(k); }
    const ss = {};
    for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (!isOurs(k)) ss[k] = sessionStorage.getItem(k); }
    const dbs = {};
    if (indexedDB.databases) for (const info of await indexedDB.databases()) if (info.name) dbs[info.name] = await dumpDb(info.name);
    return {
      url: location.href, localStorage: sortObj(ls), sessionStorage: sortObj(ss), cookies: sortObj(readCookies()), serviceWorkers: await readServiceWorkers(),
      indexedDB: sortObj(dbs), meta: { notCaptured: NOT_CAPTURED },
    };
  }

  // Service workers: unregister what the snapshot did not have, register what it did. Only registration state travels.
  async function restoreServiceWorkers(want) {
    if (!navigator.serviceWorker || !navigator.serviceWorker.getRegistrations) return;
    const wantBy = new Map((want || []).map((w) => [w.scope, w]));
    for (const r of await navigator.serviceWorker.getRegistrations()) {
      const w = r.active || r.waiting || r.installing;
      const target = wantBy.get(pathOf(r.scope));
      if (!target || (w && pathOf(w.scriptURL) !== target.script)) await r.unregister();
    }
    const have = new Set((await readServiceWorkers()).map((s) => s.scope));
    for (const w of want || []) {
      if (have.has(w.scope) || !w.script) continue;
      const reg = await navigator.serviceWorker.register(w.script, { scope: w.scope });
      if (w.state === 'activated') for (let i = 0; i < 100 && !(reg.active && reg.active.state === 'activated'); i++) await sleep(50);
    }
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
    for (const k of Object.keys(localStorage)) if (!isOurs(k)) localStorage.removeItem(k);
    for (const [k, v] of Object.entries(world.localStorage || {})) localStorage.setItem(k, v);
    for (const k of Object.keys(sessionStorage)) if (!isOurs(k)) sessionStorage.removeItem(k);
    for (const [k, v] of Object.entries(world.sessionStorage || {})) sessionStorage.setItem(k, v);
    // cookies: expire the extras, set the missing or changed ones (path / only: see NOT_CAPTURED)
    const want = world.cookies || {};
    const have = readCookies();
    for (const k of Object.keys(have)) if (!(k in want)) document.cookie = `${k}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
    for (const [k, v] of Object.entries(want)) if (have[k] !== v) document.cookie = `${k}=${v}; path=/`;
    await restoreServiceWorkers(world.serviceWorkers);
    const existing = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name).filter(Boolean) : [];
    for (const name of new Set([...existing, ...Object.keys(world.indexedDB || {})])) {
      await restoreDb(name, world.indexedDB?.[name] || { stores: {} });
    }
    // IndexedDB cannot rewind a key generator, so a replay may hand out different keys: measure it instead of hiding it
    const drift = [];
    for (const [name, snap] of Object.entries(world.indexedDB || {})) {
      const db = await idb(indexedDB.open(name));
      try {
        for (const [store, def] of Object.entries(snap.stores || {})) {
          if (!def.autoIncrement || !db.objectStoreNames.contains(store)) continue;
          const actual = await probeGenerator(db, store);
          if (actual !== (def.keyGenerator ?? null)) drift.push({ db: name, store, expected: def.keyGenerator ?? null, actual });
        }
      } finally { db.close(); }
    }
    return { restored: true, reloading: true, drift };
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
      const t0 = nowNative();
      const found = () => (selector
        ? [...document.querySelectorAll(selector)].some((el) => !text || (el.innerText || el.textContent || '').includes(text))
        : (document.body.innerText || '').includes(text));
      while (nowNative() - t0 < timeoutMs) { if (found() !== gone) return { waitedMs: nowNative() - t0 }; await sleep(50); }
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
    // shadow replay only: the relay arms it before it restores the world (a reload), feeds each command its recorded draws, and disarms it after
    'shim.arm': ({ seed, base }) => { armReplay(seed, base); try { sessionStorage.setItem('witness_shim', JSON.stringify({ seed: nd.seed, base: nd.base })); } catch { /* per-tab memory only */ } return { armed: true, seed: nd.seed }; },
    'shim.feed': ({ now, random }) => { nd.feed = { now: Array.isArray(now) ? now.slice(0, ND_CAP) : [], random: Array.isArray(random) ? random.slice(0, ND_CAP) : [] }; return { fed: { now: nd.feed.now.length, random: nd.feed.random.length } }; },
    'shim.disarm': () => { nd.mode = nd.mode === 'replay' ? 'off' : nd.mode; nd.feed = { now: [], random: [] }; try { sessionStorage.removeItem('witness_shim'); } catch { /* nothing to clear */ } return { armed: false }; },
    // production, opt-in: record what the page draws during each command
    'shim.record': ({ on }) => { if (nd.mode !== 'replay') { nd.mode = on ? 'record' : 'off'; if (on) installShims(); } try { if (on) sessionStorage.setItem('witness_shim_rec', '1'); else sessionStorage.removeItem('witness_shim_rec'); } catch { /* per-tab memory only */ } return { recording: nd.mode === 'record' }; },
    // third-party responses (opt-in): the relay switches a page to record or replay, and feeds each replayed command the calls recorded for it
    'external.arm': ({ mode, origins }) => { armExternal(mode, origins); return { mode: ext.mode, origins: [...ext.origins] }; },
    'external.feed': ({ calls }) => { ext.feed = Array.isArray(calls) ? calls.slice(0, 50) : []; return { fed: ext.feed.length }; },
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
        const page = msg.type === 'dom.click' || msg.type === 'dom.fill'; // the commands that run page code; a read in between (the relay describes a target before clicking it) must not eat the feed
        if (page) beginDraws();
        let result = await h(msg.params || {});
        if (FLOW_READS.has(msg.type) && result && typeof result === 'object') { const seq = ++replySeq; remember(result, seq); result = { ...result, flow: { seq, load: LOAD_ID } }; }
        else if (msg.type === 'dom.fill' && result && typeof result === 'object' && typeof msg.params?.value === 'string' && served.has(msg.params.value)) result = { ...result, flow: { load: LOAD_ID, from: [{ param: 'value', seq: served.get(msg.params.value) }] } };
        if (page) {
          const drawn = endDraws();
          const extra = await endExternal();
          if (result && typeof result === 'object') result = { ...result, ...(drawn ? { nondet: drawn } : {}), ...(extra ?? {}) };
        }
        ws.send(JSON.stringify({ kind: 'reply', id: msg.id, ok: true, result }));
        if (result && result.reloading) setTimeout(() => location.reload(), 30);
      } catch (e) {
        nd.active = false; ext.active = false;
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
