// Hash-chained, signed event ledger. One chain per session: event i commits to event i-1 via
// prev_hash, and payloads live in content-addressed blobs the event commits to via data_hash.
// Seals (ed25519 over the chain head) are appended at session end and every SEAL_EVERY events.
// Tampering with any event, blob, ordering, or seal is detected by verifySession(), which is a
// pure function so an exported bundle verifies offline with no database.
import { DatabaseSync } from 'node:sqlite';
import { canon, sha256 } from './canon.mjs';
import { signMessage, verifySignature, fingerprint, keyCert, verifyCert, makeRevocation, verifyRevocation, approvalMessage } from './attest.mjs';

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
const safeParse = (s) => { try { return JSON.parse(s); } catch { return null; } };
export const sealMessage = (s) => canon({ session_id: s.session_id, head_idx: s.head_idx, head_hash: s.head_hash, ts: s.ts });

// Pure verification. events: ordered rows of one session. blobs: {hash: canonicalJsonString}.
export function verifySession({ events, blobs = {}, seals = [], strict = false, trustedKey = null, trustedKeys = null, trustedApprovers = null, rotations = [], anchors = null }) {
  const problems = [];
  const warnings = [];
  const fail = (idx, reason) => problems.push({ idx, reason });
  let prev = GENESIS;
  const decisions = []; // second (human) decisions, for --trusted-approver
  const chainCerts = []; // key.rotate events: the old key vouches for the new one
  const chainRevokes = []; // key.revoke events
  const begun = new Map(); // command.begin idx -> intent idx; a released irreversible dispatch must get a result
  const resolved = new Set();
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
    if ((e.kind === 'key.rotate' || e.kind === 'key.revoke') && e.data_hash && blobs[e.data_hash] !== undefined && sha256(blobs[e.data_hash]) === e.data_hash) {
      const d = safeParse(blobs[e.data_hash]);
      if (d) (e.kind === 'key.rotate' ? chainCerts : chainRevokes).push({ idx: e.idx, data: d });
    }
    if (e.kind === 'decision' && e.data_hash && blobs[e.data_hash] !== undefined && sha256(blobs[e.data_hash]) === e.data_hash) {
      const d = safeParse(blobs[e.data_hash]);
      if (d && d.resolves_idx !== undefined) decisions.push({ idx: e.idx, session: e.session_id, data: d });
    }
    if (e.kind === 'command.begin') begun.set(e.idx, e.data_hash && blobs[e.data_hash] !== undefined ? safeParse(blobs[e.data_hash])?.intent_idx ?? null : null);
    else if (e.kind === 'command' && e.data_hash && blobs[e.data_hash] !== undefined) {
      const b = safeParse(blobs[e.data_hash])?.begin_idx;
      if (Number.isInteger(b)) resolved.add(b);
    }
    prev = e.hash;
  });
  // Write-ahead: the begin is committed before the click, so a begin with no result means the effect may
  // have happened without a record. Reported, never silently dropped: a warning, and an error under strict.
  for (const [idx, intent] of begun) {
    if (resolved.has(idx)) continue;
    const reason = `unresolved dispatch: ${intent === null ? 'a command' : `intent #${intent}`} was released and dispatched but no result was recorded`;
    if (strict) fail(idx, reason); else warnings.push({ idx, reason });
  }
  // Trust in signing keys. With a pin (trustedKey/trustedKeys) a seal counts only if its key is reachable from a
  // pinned key through valid rotation certs; without a pin every internally consistent key is accepted, as before.
  // A key revoked at event R (by a key that is itself trusted) loses every seal whose head is after R.
  const pinned = new Set([...(trustedKeys ?? []), ...(trustedKey ? [trustedKey] : [])]);
  const validSeals = seals.filter((s) => verifySignature(s.pubkey, sealMessage(s), s.sig));
  const sealFps = new Set(validSeals.map((s) => fingerprint(s.pubkey)));
  const certs = [...rotations.map((cert) => ({ idx: null, cert })), ...chainCerts.map((c) => ({ idx: c.idx, cert: c.data }))].filter((c) => verifyCert(c.cert));
  const reach = (start, revokedAt) => {
    const set = new Set(start);
    for (let grew = true; grew;) {
      grew = false;
      for (const { idx, cert } of certs) {
        const from = fingerprint(cert.old_pub); const to = fingerprint(cert.new_pub);
        if (set.has(to) || !set.has(from)) continue;
        const r = revokedAt?.get(from); // a bundle-level cert has no position, so a revoked signer cannot vouch at all
        if (r !== undefined && (idx === null || r < idx)) continue;
        set.add(to); grew = true;
      }
    }
    return set;
  };
  const provisional = reach(pinned, null);
  const revokedAt = new Map();
  for (const { idx, data } of chainRevokes) {
    if (!verifyRevocation(data)) { fail(idx, 'key.revoke signature invalid'); continue; }
    const by = fingerprint(data.revoker_pub);
    if (!(pinned.size ? provisional.has(by) : sealFps.has(by) || provisional.has(by))) { fail(idx, 'key.revoke signed by a key that is not trusted'); continue; }
    if (!revokedAt.has(data.fingerprint)) revokedAt.set(data.fingerprint, idx);
  }
  const trusted = reach(pinned, revokedAt);
  const signers = new Set();
  let sealedThrough = -1;
  for (const s of seals) {
    const at = s.head_idx;
    if (!verifySignature(s.pubkey, sealMessage(s), s.sig)) { fail(at, 'seal signature invalid'); continue; }
    const fp = fingerprint(s.pubkey);
    signers.add(fp);
    if (pinned.size && !trusted.has(fp)) { fail(at, 'seal signed by an untrusted key'); continue; }
    if (revokedAt.has(fp) && at > revokedAt.get(fp)) { fail(at, `seal signed by a key revoked at event #${revokedAt.get(fp)}`); continue; }
    if (at >= events.length) { fail(at, 'seal covers an event that is missing (truncated tail)'); continue; }
    if (events[at].hash !== s.head_hash) { fail(at, 'seal head hash does not match the chain'); continue; }
    sealedThrough = Math.max(sealedThrough, at);
  }
  // Approver pinning: every human decision that RELEASED an action must carry a signature by a listed approver key over
  // {id, verdict, nonce}. Refusals need no proof (they release nothing). Auto-approval is only legitimate inside a fork,
  // which is recognisable by its fork.start event, so a forged "auto-approve" in a production chain does not pass.
  if (trustedApprovers) {
    const allowed = new Set(trustedApprovers);
    const isFork = events.some((e) => e.kind === 'fork.start');
    for (const { idx, session, data: d } of decisions) {
      if (d.verdict !== 'allow') continue;
      if (d.by === 'auto-approve' && isFork) continue;
      if (!d.sig || !d.approver_pub) { fail(idx, 'approval is not signed by an approver key'); continue; }
      const fp = fingerprint(d.approver_pub);
      if (fp !== d.approver_fp) fail(idx, 'approval names a different approver fingerprint than the key that signed it');
      else if (!allowed.has(fp)) fail(idx, `approval signed by ${fp}, which is not a trusted approver`);
      else if (!verifySignature(d.approver_pub, approvalMessage({ id: `${session}.${d.intent_idx}`, verdict: d.verdict, nonce: d.nonce }), d.sig)) fail(idx, 'approval signature does not match the recorded intent, verdict and nonce');
    }
  }
  // Anchors were copied outside the ledger. Every anchored head of this session must still be on the chain
  // with the same hash: a whole-history rewrite resealed with the same key changes the hash and is caught here.
  // Asking for anchors but having none for this session is a failure, never a pass.
  if (anchors) {
    const sid = events[0]?.session_id;
    const mine = anchors.filter((a) => a.session === sid);
    if (!mine.length) fail(events.length - 1, 'no anchor record for this session, so nothing outside the ledger confirms it');
    for (const a of mine) {
      if (a.head_idx >= events.length) fail(a.head_idx, 'history is shorter than an anchored seal (truncated relative to the anchor)');
      else if (events[a.head_idx].hash !== a.head_hash) fail(a.head_idx, 'history differs from the anchored seal (rewritten after it was anchored)');
    }
  }
  const last = events.length - 1;
  const ended = last >= 0 && events[last].kind === 'session.end';
  if (strict) {
    if (!ended) fail(last, 'session has no session.end event');
    if (sealedThrough < last) fail(last, 'tail after the last seal is not attested');
  }
  const badIdx = problems.length ? Math.min(...problems.map((p) => p.idx)) : null;
  return {
    ok: problems.length === 0, checked: events.length, badIdx, problems, warnings,
    ended, sealedThrough, signers: [...signers],
  };
}

export function verifyBundle(bundle, opts = {}) {
  if (!bundle || bundle.format !== BUNDLE_FORMAT) return { ok: false, checked: 0, badIdx: null, problems: [{ idx: null, reason: 'not a witnessloop bundle' }], warnings: [], signers: [] };
  return verifySession({ events: bundle.events, blobs: bundle.blobs, seals: bundle.seals, strict: opts.strict ?? true, trustedKey: opts.trustedKey ?? null, trustedKeys: opts.trustedKeys ?? null, trustedApprovers: opts.trustedApprovers ?? null, rotations: bundle.rotations ?? [], anchors: opts.anchors ?? null });
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
      CREATE TABLE IF NOT EXISTS rotations (
        id INTEGER PRIMARY KEY AUTOINCREMENT, old_pub TEXT NOT NULL, new_pub TEXT NOT NULL, ts TEXT NOT NULL, sig TEXT NOT NULL
      );
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

  blobBytes(hash) {
    if (!hash) return 0;
    return this.db.prepare('SELECT length(CAST(json AS BLOB)) AS n FROM blobs WHERE hash = ?').get(hash)?.n ?? 0;
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

  // The record to copy outside the ledger. An active session is sealed at its current head first so the
  // anchor covers everything recorded so far; an ended session already ends in a seal.
  anchorRecord(sessionId) {
    const sid = Number(sessionId);
    const s = this.getSession(sid);
    if (!s) throw new Error(`no such session ${sid}`);
    if (s.status === 'active') this.seal(sid);
    const seal = this.seals(sid).at(-1);
    if (!seal) throw new Error(`session ${sid} has no seal to anchor (the ledger has no signing key)`);
    return { session: sid, head_idx: seal.head_idx, head_hash: seal.head_hash, ts: seal.ts, seal };
  }

  rotations() {
    return this.db.prepare('SELECT old_pub, new_pub, ts, sig FROM rotations ORDER BY id').all();
  }

  // Switch to a new signing key. Every active session records the rotation (signed by the OLD key) and is
  // sealed by the old key before the switch, so the chain itself shows where one key handed over to the next.
  // The cert is also kept in the ledger and travels in every bundle, so sessions started later verify from the old pin.
  rotateKey(newKey) {
    if (!this.key) throw new Error('ledger has no signing key to rotate');
    const cert = keyCert(this.key, newKey.publicKey, this.now());
    this.db.prepare('INSERT INTO rotations (old_pub, new_pub, ts, sig) VALUES (?, ?, ?, ?)').run(cert.old_pub, cert.new_pub, cert.ts, cert.sig);
    for (const s of this.listSessions().filter((x) => x.status === 'active')) {
      this.append(s.id, { kind: 'key.rotate', actor: 'relay', data: cert });
      this.seal(s.id);
    }
    this.key = newKey;
    return cert;
  }

  // Declare another key untrusted for seals made after this point in every active session. The current
  // signing key cannot be revoked (that would strand everything it signs next): rotate first.
  revokeKey(revokedFingerprint) {
    if (!this.key) throw new Error('ledger has no signing key');
    if (revokedFingerprint === fingerprint(this.key.publicKey)) throw new Error('refusing to revoke the current signing key: rotate first');
    const rev = makeRevocation(this.key, revokedFingerprint, this.now());
    const sessions = [];
    for (const s of this.listSessions().filter((x) => x.status === 'active')) {
      this.append(s.id, { kind: 'key.revoke', actor: 'relay', data: rev });
      this.seal(s.id);
      sessions.push(s.id);
    }
    return { revocation: rev, sessions };
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
    return { format: BUNDLE_FORMAT, exportedAt: this.now(), session: this.getSession(sessionId), events, blobs, seals: this.seals(sessionId), rotations: this.rotations() };
  }

  // Verify one session in place. Also anchors a fork to its parent: the parent head hash the fork
  // recorded must exist in the parent's chain, otherwise the fork claims a past that never was.
  verifySessionId(sessionId, opts = {}) {
    const b = this.bundle(sessionId);
    const r = verifySession({ events: b.events, blobs: b.blobs, seals: b.seals, strict: opts.strict ?? false, trustedKey: opts.trustedKey ?? null, trustedKeys: opts.trustedKeys ?? null, trustedApprovers: opts.trustedApprovers ?? null, rotations: b.rotations, anchors: opts.anchors ?? null });
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
