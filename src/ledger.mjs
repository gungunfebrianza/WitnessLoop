// Hash-chained, signed event ledger. One chain per session: event i commits to event i-1 via
// prev_hash, and payloads live in content-addressed blobs the event commits to via data_hash.
// Seals (ed25519 over the chain head) are appended at session end and every SEAL_EVERY events.
// Tampering with any event, blob, ordering, or seal is detected by verifySession(), which is a
// pure function so an exported bundle verifies offline with no database.
import { DatabaseSync } from 'node:sqlite';
import { canon, sha256 } from './canon.mjs';
import { signMessage, verifySignature, fingerprint } from './attest.mjs';

export const GENESIS = '0'.repeat(64);
export const BUNDLE_FORMAT = 'witnessloop.bundle/1';
const SEAL_EVERY = 50;

export function eventBody(e) {
  return {
    idx: e.idx, session_id: e.session_id, ts: e.ts, kind: e.kind,
    actor: e.actor ?? null, type: e.type ?? null, effect: e.effect ?? null,
    ok: e.ok ?? null, data_hash: e.data_hash ?? null,
  };
}
export const eventHash = (prev, e) => sha256(prev + '\n' + canon(eventBody(e)));
export const sealMessage = (s) => canon({ session_id: s.session_id, head_idx: s.head_idx, head_hash: s.head_hash, ts: s.ts });

// Pure verification. events: ordered rows of one session. blobs: {hash: canonicalJsonString}.
export function verifySession({ events, blobs = {}, seals = [], strict = false, trustedKey = null }) {
  const problems = [];
  const fail = (idx, reason) => problems.push({ idx, reason });
  let prev = GENESIS;
  events.forEach((e, i) => {
    if (e.idx !== i) fail(i, `gap or reorder: expected idx ${i}, found ${e.idx}`);
    if (e.prev_hash !== prev) fail(i, 'prev_hash does not match the previous event');
    if (eventHash(e.prev_hash, e) !== e.hash) fail(i, 'event hash does not match its content');
    if (e.data_hash) {
      const b = blobs[e.data_hash];
      if (b === undefined) fail(i, 'payload blob missing');
      else if (sha256(b) !== e.data_hash) fail(i, 'payload blob does not match its hash');
      else if (e.kind === 'checkpoint') {
        // a checkpoint commits to a whole world snapshot by hash; it must travel with the bundle
        const wh = JSON.parse(b).world_hash;
        if (wh && blobs[wh] === undefined) fail(i, 'world snapshot blob missing');
        else if (wh && sha256(blobs[wh]) !== wh) fail(i, 'world snapshot does not match its hash');
      }
    }
    prev = e.hash;
  });
  const signers = new Set();
  let sealedThrough = -1;
  for (const s of seals) {
    const at = s.head_idx;
    if (!verifySignature(s.pubkey, sealMessage(s), s.sig)) { fail(at, 'seal signature invalid'); continue; }
    signers.add(fingerprint(s.pubkey));
    if (trustedKey && fingerprint(s.pubkey) !== trustedKey) fail(at, 'seal signed by an untrusted key');
    if (at >= events.length) { fail(at, 'seal covers an event that is missing (truncated tail)'); continue; }
    if (events[at].hash !== s.head_hash) { fail(at, 'seal head hash does not match the chain'); continue; }
    sealedThrough = Math.max(sealedThrough, at);
  }
  const last = events.length - 1;
  const ended = last >= 0 && events[last].kind === 'session.end';
  if (strict) {
    if (!ended) fail(last, 'session has no session.end event');
    if (sealedThrough < last) fail(last, 'tail after the last seal is not attested');
  }
  const badIdx = problems.length ? Math.min(...problems.map((p) => p.idx)) : null;
  return {
    ok: problems.length === 0, checked: events.length, badIdx, problems,
    ended, sealedThrough, signers: [...signers],
  };
}

export function verifyBundle(bundle, opts = {}) {
  if (!bundle || bundle.format !== BUNDLE_FORMAT) return { ok: false, checked: 0, badIdx: null, problems: [{ idx: null, reason: 'not a witnessloop bundle' }], signers: [] };
  return verifySession({ events: bundle.events, blobs: bundle.blobs, seals: bundle.seals, strict: opts.strict ?? true, trustedKey: opts.trustedKey ?? null });
}

export class Ledger {
  constructor(dbPath = ':memory:', { key = null, sealEvery = SEAL_EVERY, now = () => new Date().toISOString() } = {}) {
    this.db = new DatabaseSync(dbPath);
    this.key = key;
    this.sealEvery = sealEvery;
    this.now = now;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, goal TEXT, actor TEXT, agent TEXT,
        status TEXT NOT NULL DEFAULT 'active', parent_session INTEGER, created_at TEXT NOT NULL, ended_at TEXT
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, idx INTEGER NOT NULL,
        ts TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT, type TEXT, effect TEXT, ok INTEGER,
        data_hash TEXT, prev_hash TEXT NOT NULL, hash TEXT NOT NULL,
        UNIQUE (session_id, idx)
      );
      CREATE TABLE IF NOT EXISTS blobs (hash TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS seals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL, head_idx INTEGER NOT NULL,
        head_hash TEXT NOT NULL, sig TEXT NOT NULL, pubkey TEXT NOT NULL, ts TEXT NOT NULL
      );
    `);
  }

  close() { this.db.close(); }

  putBlob(value) {
    const json = canon(value);
    const hash = sha256(json);
    this.db.prepare('INSERT OR IGNORE INTO blobs (hash, json) VALUES (?, ?)').run(hash, json);
    return hash;
  }

  getBlob(hash) {
    if (!hash) return null;
    const row = this.db.prepare('SELECT json FROM blobs WHERE hash = ?').get(hash);
    return row ? JSON.parse(row.json) : null;
  }

  startSession({ goal = '', actor = 'agent', agent = 'default', parent = null, meta = {} } = {}) {
    const info = this.db.prepare('INSERT INTO sessions (goal, actor, agent, parent_session, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(goal, actor, agent, parent, this.now());
    const id = Number(info.lastInsertRowid);
    this.append(id, { kind: 'session.start', actor, data: { goal, actor, agent, parent, ...meta } });
    return id;
  }

  getSession(id) {
    return this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(Number(id)) ?? null;
  }

  listSessions() {
    return this.db.prepare('SELECT * FROM sessions ORDER BY id').all();
  }

  activeSession(agent) {
    return this.db.prepare("SELECT * FROM sessions WHERE status = 'active' AND agent = ? ORDER BY id DESC LIMIT 1").get(agent) ?? null;
  }

  head(sessionId) {
    const row = this.db.prepare('SELECT idx, hash FROM events WHERE session_id = ? ORDER BY idx DESC LIMIT 1').get(Number(sessionId));
    return row ? { idx: row.idx, hash: row.hash } : { idx: -1, hash: GENESIS };
  }

  append(sessionId, { kind, actor = null, type = null, effect = null, ok = null, data = undefined }) {
    const sid = Number(sessionId);
    if (!this.getSession(sid)) throw new Error(`no such session ${sid}`);
    const head = this.head(sid);
    const data_hash = data === undefined ? null : this.putBlob(data);
    const e = {
      idx: head.idx + 1, session_id: sid, ts: this.now(), kind, actor, type, effect,
      ok: ok === null ? null : ok ? 1 : 0, data_hash,
    };
    e.prev_hash = head.hash;
    e.hash = eventHash(e.prev_hash, e);
    const info = this.db.prepare(`INSERT INTO events (session_id, idx, ts, kind, actor, type, effect, ok, data_hash, prev_hash, hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(e.session_id, e.idx, e.ts, e.kind, e.actor, e.type, e.effect, e.ok, e.data_hash, e.prev_hash, e.hash);
    e.seq = Number(info.lastInsertRowid);
    if (this.key && kind !== 'session.end' && (e.idx + 1) % this.sealEvery === 0) this.seal(sid);
    return e;
  }

  events(sessionId, { hydrate = false } = {}) {
    const rows = this.db.prepare('SELECT * FROM events WHERE session_id = ? ORDER BY idx').all(Number(sessionId));
    return hydrate ? rows.map((r) => ({ ...r, data: this.getBlob(r.data_hash) })) : rows;
  }

  event(sessionId, idx, { hydrate = true } = {}) {
    const r = this.db.prepare('SELECT * FROM events WHERE session_id = ? AND idx = ?').get(Number(sessionId), Number(idx));
    if (!r) return null;
    return hydrate ? { ...r, data: this.getBlob(r.data_hash) } : r;
  }

  seal(sessionId) {
    if (!this.key) throw new Error('ledger has no signing key');
    const sid = Number(sessionId);
    const head = this.head(sid);
    if (head.idx < 0) throw new Error('nothing to seal');
    const s = { session_id: sid, head_idx: head.idx, head_hash: head.hash, ts: this.now() };
    s.sig = signMessage(this.key.privateKey, sealMessage(s));
    s.pubkey = this.key.publicKey;
    this.db.prepare('INSERT INTO seals (session_id, head_idx, head_hash, sig, pubkey, ts) VALUES (?, ?, ?, ?, ?, ?)')
      .run(s.session_id, s.head_idx, s.head_hash, s.sig, s.pubkey, s.ts);
    return s;
  }

  seals(sessionId) {
    return this.db.prepare('SELECT session_id, head_idx, head_hash, sig, pubkey, ts FROM seals WHERE session_id = ? ORDER BY id').all(Number(sessionId));
  }

  endSession(sessionId, summary = {}) {
    const sid = Number(sessionId);
    const s = this.getSession(sid);
    if (!s) throw new Error(`no such session ${sid}`);
    if (s.status !== 'active') throw new Error(`session ${sid} already ended`);
    const e = this.append(sid, { kind: 'session.end', actor: s.actor, data: summary });
    if (this.key) this.seal(sid);
    this.db.prepare("UPDATE sessions SET status = 'ended', ended_at = ? WHERE id = ?").run(this.now(), sid);
    return e;
  }

  // Self-contained bundle: verifies with verifyBundle() and no other input.
  bundle(sessionId) {
    const events = this.events(sessionId).map(({ seq, ...rest }) => rest);
    const blobs = {};
    const rawBlob = (h) => this.db.prepare('SELECT json FROM blobs WHERE hash = ?').get(h)?.json;
    for (const e of events) {
      if (!e.data_hash) continue;
      blobs[e.data_hash] = rawBlob(e.data_hash);
      if (e.kind === 'checkpoint' && blobs[e.data_hash]) {
        const wh = JSON.parse(blobs[e.data_hash]).world_hash;
        if (wh) blobs[wh] = rawBlob(wh);
      }
    }
    return { format: BUNDLE_FORMAT, exportedAt: this.now(), session: this.getSession(sessionId), events, blobs, seals: this.seals(sessionId) };
  }

  // Verify one session in place. Also anchors a fork to its parent: the parent head hash the fork
  // recorded must exist in the parent's chain, otherwise the fork claims a past that never was.
  verifySessionId(sessionId, opts = {}) {
    const b = this.bundle(sessionId);
    const r = verifySession({ events: b.events, blobs: b.blobs, seals: b.seals, strict: opts.strict ?? false, trustedKey: opts.trustedKey ?? null });
    const start = b.events[0] ? this.getBlob(b.events[0].data_hash) : null;
    const forkEvent = b.events.find((e) => e.kind === 'fork.start');
    if (forkEvent) {
      const f = this.getBlob(forkEvent.data_hash);
      const parentEvent = this.event(f.parent_session, f.parent_head_idx, { hydrate: false });
      if (!parentEvent || parentEvent.hash !== f.parent_head_hash) {
        r.ok = false;
        r.problems.push({ idx: forkEvent.idx, reason: 'fork anchor does not match the parent chain' });
        r.badIdx = Math.min(r.badIdx ?? Infinity, forkEvent.idx);
      }
    }
    r.session = sessionId;
    r.goal = start?.goal ?? null;
    return r;
  }

  verifyAll(opts = {}) {
    const results = this.listSessions().map((s) => this.verifySessionId(s.id, opts));
    return { ok: results.every((r) => r.ok), sessions: results };
  }
}
