// HTTP + WebSocket hub. Agents (browser pages running src/agent/inject.js) connect over WS;
// callers (CLI, MCP, scripts) drive them over HTTP. Every command passes through runCommand(),
// which is where the ledger, the gate and the world checkpoints meet.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger } from './ledger.mjs';
import { loadOrCreateKey, generateKey, saveKey, fingerprint } from './attest.mjs';
import { newToken, tokenMatches, bearerOf, writeTokenFile, DEFAULT_TOKEN_FILE } from './auth.mjs';
import { acceptWebSocket } from './ws.mjs';
import { COMMANDS, classify, timeoutFor } from './registry.mjs';
import { validatePolicy, DEFAULT_POLICY } from './policy.mjs';
import { gate, Approvals } from './gate.mjs';
import { captureWorld, restoreWorld, stateHash, redactWorld, validateRedactKeys } from './world.mjs';
import { installAnalysisRoutes } from './routes-analysis.mjs';
import { installDashboardRoutes } from './dashboard.mjs';
import { validateOrigins, cleanExternal } from './external.mjs';

export const DEFAULT_PORT = 8974;
const DASHBOARD_HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dashboard', 'index.html');

// What the page's observer reported is untrusted input: keep only the four expected fields, bounded, so a page cannot
// stuff arbitrary data (or credentials it chose to include) into the ledger through this channel.
const clip = (v) => (typeof v === 'string' ? v.slice(0, 200) : null);
export const cleanEffects = (list) => (Array.isArray(list) ? list.slice(0, 50).filter((x) => x && typeof x === 'object').map((x) => ({ method: clip(x.method)?.toUpperCase() ?? null, origin: clip(x.origin), path: clip(x.path), body_hash: clip(x.body_hash) })) : []);
// DNS rebinding: a hostile page can point its own hostname at 127.0.0.1 and then talk to the relay as "same origin".
// Its requests still carry ITS hostname in Host, so only loopback names are served; a browser also states the page's
// Origin on cross-origin and POST requests, and for HTTP that must be this relay itself (the dashboard). CLI/MCP send neither.
export const hostAllowed = (host) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host ?? '');
export const originAllowed = (origin, host) => origin === undefined || origin === `http://${host}`;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

export async function createRelay({
  dbPath = ':memory:', keyPath = null, port = DEFAULT_PORT, host = '127.0.0.1', policy = null, profile = {},
  approvalTimeoutMs = 300000, checkpoints = 'mutating', now, anchorSink = null, anchorFile = null, approvers = [], allowUnsignedApprovals = false, token = newToken(), recordNondeterminism = false, externalOrigins = [],
} = {}) {
  const extOrigins = validateOrigins(externalOrigins);
  if (!token) throw new Error('createRelay needs a token: an unauthenticated relay is not an option');
  const key = keyPath ? loadOrCreateKey(keyPath) : generateKey();
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const ledger = new Ledger(dbPath, { key, ...(now ? { now } : {}) });
  const approvals = new Approvals({ timeoutMs: approvalTimeoutMs, approvers, allowUnsigned: allowUnsignedApprovals });
  const agents = new Map();
  const pending = new Map();
  let nextId = 0;
  let currentPolicy = validatePolicy(policy ?? DEFAULT_POLICY);
  const volatileKeys = profile.volatileKeys ?? [];
  const redactKeys = validateRedactKeys(profile.redactKeys);

  // ---------- agent link ----------
  const agentInfo = (name) => {
    const a = agents.get(name);
    return a ? { name, loadId: a.loadId, origin: a.origin, adapter: a.adapter, connectedAt: a.connectedAt } : null;
  };

  function dispatch(agent, type, params = {}, timeoutMs) {
    const a = agents.get(agent);
    if (!a) return Promise.reject(new HttpError(409, `agent "${agent}" is not connected`));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new HttpError(504, `${type} timed out`)); }, timeoutMs ?? timeoutFor(type, params));
      pending.set(id, { resolve, reject, timer, conn: a.conn, type });
      a.conn.send(JSON.stringify({ kind: 'command', id, type, params }));
    });
  }

  function handleAgentMessage(conn, text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.kind === 'observed') {
      // a native form submit is about to unload the page: keep what was seen in case the click's reply never arrives
      for (const p of pending.values()) if (p.conn === conn && p.type === 'dom.click') p.observed = [...(p.observed ?? []), ...cleanEffects(msg.effects)].slice(0, 50);
      return;
    }
    if (msg.kind !== 'reply') return;
    const p = pending.get(msg.id);
    if (!p || p.conn !== conn) return;
    clearTimeout(p.timer);
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result); else p.reject(new Error(msg.error || `${p.type} failed`));
  }

  async function waitForReconnect(agent, oldLoadId, timeoutMs = 15000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const a = agents.get(agent);
      if (a && a.loadId !== oldLoadId) return true;
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new HttpError(504, `agent "${agent}" did not reconnect after reload`);
  }

  const bridge = { dispatch, agentInfo, waitForReconnect };

  // ---------- sessions and checkpoints ----------
  // The one place a snapshot becomes a blob: profile.redactKeys is applied here, so a secret never reaches the ledger or a bundle.
  // The hash is over the redacted world (a restore of it recaptures and redacts to the same thing); checks that ran on the live capture saw the real one.
  // coverage says what the snapshot holds, what it cannot, and how many values were redacted.
  function storeWorld(world) {
    const r = redactWorld(world, redactKeys);
    const captured = ['localStorage', 'sessionStorage', 'cookies', 'serviceWorkers', 'indexedDB'].filter((k) => r.world.page?.[k] !== undefined).concat(r.world.server != null ? ['server'] : []);
    return { world_hash: ledger.putBlob(r.world), state_hash: stateHash(r.world, volatileKeys), coverage: { captured, notCaptured: r.world.page?.meta?.notCaptured ?? [], redacted: r.count } };
  }
  async function checkpoint(sessionId, label, afterIdx = null) {
    const session = ledger.getSession(sessionId);
    const world = await captureWorld(bridge, session.agent);
    return ledger.append(sessionId, { kind: 'checkpoint', actor: 'relay', data: { label, after_idx: afterIdx, ...storeWorld(world) } });
  }

  async function startSession({ goal = '', actor = 'agent', agent = 'default', parent = null, meta = {} } = {}) {
    if (!agents.has(agent)) throw new HttpError(409, `agent "${agent}" is not connected`);
    if (ledger.activeSession(agent)) throw new HttpError(409, `agent "${agent}" already has an active session`);
    // What this session records beyond the command stream is written into session.start, so a replay knows what it can rely on.
    // A recording the operator asked for that cannot be switched on refuses the session: better no session than one that claims a record it lacks.
    const recording = !meta.fork && (recordNondeterminism || extOrigins.length) ? { ...(recordNondeterminism ? { nondeterminism: true } : {}), ...(extOrigins.length ? { external: extOrigins } : {}) } : null;
    if (recording?.nondeterminism) {
      try { await dispatch(agent, 'shim.record', { on: true }); } catch (e) { throw new HttpError(409, `cannot record nondeterminism on agent "${agent}": ${e.message}`); }
    }
    if (recording?.external) {
      try { await dispatch(agent, 'external.arm', { mode: 'record', origins: extOrigins }); } catch (e) { throw new HttpError(409, `cannot record external responses on agent "${agent}": ${e.message}`); }
    }
    const id = ledger.startSession({ goal, actor, agent, parent, meta: { ...meta, ...(recording ? { recording } : {}) } });
    if (checkpoints !== 'none') await checkpoint(id, 'genesis');
    return id;
  }

  function endSession(sessionId, summary = {}) {
    const events = ledger.events(sessionId);
    const counts = {};
    for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    return ledger.endSession(sessionId, { ...summary, counts });
  }

  // ---------- the command pipeline ----------
  async function runCommand({ sessionId, type, params = {}, actor = 'agent', internal = false, policy: policyOverride = null, autoApprove = false }) {
    const session = ledger.getSession(sessionId);
    if (!session || session.status !== 'active') throw new HttpError(409, `session ${sessionId} is not active`);
    const def = COMMANDS[type];
    if (!def) throw new HttpError(400, `unknown command "${type}"`);
    if (def.internal && !internal) throw new HttpError(403, `"${type}" is internal`);
    const agent = session.agent;

    let describe = null;
    if (def.effect === 'dynamic') {
      try { describe = await dispatch(agent, 'dom.describe', { selector: params.selector, nth: params.nth }); } catch { describe = null; }
    }
    const effect = classify(type, describe);

    let intentIdx = null;
    let before = null;
    if (effect === 'irreversible') {
      const g = await gate({
        ledger, approvals, policy: policyOverride ?? currentPolicy, sessionId, actor, type, effect, params, describe, agent, autoApprove,
      });
      intentIdx = g.intent.idx;
      if (!g.released) {
        return { ok: false, denied: true, effect, verdict: g.verdict, reason: g.reason, intentIdx, decisionIdx: g.decision.idx };
      }
      if (profile.effectCheck) before = await captureWorld(bridge, agent);
    }

    // Write-ahead: the begin is on the ledger before the click. If the result cannot be recorded later,
    // verify reports this begin as an unresolved dispatch. If the begin itself cannot be recorded, nothing is dispatched.
    const begin = effect !== 'read' ? ledger.append(sessionId, { kind: 'command.begin', actor, type, effect, data: { params, ...(intentIdx !== null ? { intent_idx: intentIdx } : {}) } }) : null;
    const t0 = Date.now();
    let result;
    let error;
    let lost = null;
    try { result = await dispatch(agent, type, params); } catch (e) { error = e.message; lost = e.observed ?? null; }
    // writes the click made on the network, as the page's observer saw them (a click whose reply was lost keeps what was pushed before the page went)
    const observed = cleanEffects(result?.observed_effects ?? lost);
    if (result && typeof result === 'object' && 'observed_effects' in result) result = { ...result, observed_effects: observed };
    // third-party responses the page saw during this command (opt-in): each body becomes its own blob the command event commits to by hash
    let external = null;
    if (result && typeof result === 'object' && 'external' in result) {
      const { external: raw, ...rest } = result;
      result = rest;
      external = cleanExternal(raw, extOrigins).map(({ body_b64, ...meta }) => ({ ...meta, ...(body_b64 !== null ? { response_hash: ledger.putBlob({ body_b64 }) } : {}) }));
    }
    const cmd = ledger.append(sessionId, {
      kind: 'command', actor, type, effect, ok: !error,
      data: { params, ...(describe ? { describe } : {}), ...(intentIdx !== null ? { intent_idx: intentIdx } : {}), ...(begin ? { begin_idx: begin.idx } : {}), result, error, ...(lost?.length ? { observed_effects: observed } : {}), ...(external?.length ? { external } : {}), ms: Date.now() - t0 },
    });

    // Detection after the fact: the request has already gone. A write under a reversible or unannotated label is what the gate could not see.
    if (effect !== 'irreversible' && type === 'dom.click') {
      // an entry with no readable method counts as a write: when in doubt, flag
      const writes = observed.filter((x) => !SAFE_METHODS.has(x.method));
      if (writes.length) {
        ledger.append(sessionId, { kind: 'flag', actor: 'relay', type: 'undeclared_effect', ok: false, data: { command_idx: cmd.idx, intent_idx: null, why: 'undeclared network effect', declared: describe?.declared ?? null, evidence: writes } });
      }
    }

    let after = null;
    const wantsCheckpoint = effect !== 'read' && (checkpoints === 'mutating' || (checkpoints === 'irreversible' && effect === 'irreversible'));
    if (wantsCheckpoint || (effect === 'irreversible' && profile.effectCheck)) {
      after = await captureWorld(bridge, agent);
      if (wantsCheckpoint) {
        ledger.append(sessionId, { kind: 'checkpoint', actor: 'relay', data: { label: 'post', after_idx: cmd.idx, ...storeWorld(after) } });
      }
    }

    let flagged = null;
    if (effect === 'irreversible' && profile.effectCheck && !error) {
      const chk = await profile.effectCheck({ type, params, preview: describe?.preview ?? null, result, before, after });
      if (chk && chk.ok === false) {
        flagged = { why: chk.why, evidence: chk.evidence ?? null };
        ledger.append(sessionId, { kind: 'flag', actor: 'relay', type: 'effect_mismatch', ok: false, data: { command_idx: cmd.idx, intent_idx: intentIdx, ...flagged } });
      }
    }
    return { ok: !error, result, error, effect, idx: cmd.idx, ...(intentIdx !== null ? { intentIdx } : {}), ...(flagged ? { flagged } : {}) };
  }

  const api = {
    ledger, approvals, profile, bridge, volatileKeys, agents, token, anchorFile,
    dispatch, agentInfo, waitForReconnect, checkpoint, startSession, endSession, runCommand,
    httpError: (status, message) => new HttpError(status, message),
    getPolicy: () => currentPolicy,
    setPolicy: (p) => { currentPolicy = validatePolicy(p); return currentPolicy; },
    captureWorld: (agent) => captureWorld(bridge, agent),
    restoreWorld: (agent, world) => restoreWorld(bridge, agent, world),
  };

  // ---------- HTTP ----------
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`), handler });

  route('GET', '/health', () => ({ ok: true, agents: [...agents.keys()], sessions: ledger.listSessions().length, port: api.port }));
  route('GET', '/agents', () => [...agents.keys()].map(agentInfo));
  route('GET', '/policy', () => currentPolicy);
  route('PUT', '/policy', ({ body }) => api.setPolicy(body));

  route('POST', '/sessions', async ({ body }) => ({ id: await startSession(body ?? {}) }));
  route('GET', '/sessions', () => ledger.listSessions());
  route('POST', '/sessions/:id/end', async ({ params, body }) => {
    const s = ledger.getSession(params.id);
    if (!s) throw new HttpError(404, `no such session ${params.id}`);
    if (s.status !== 'active') throw new HttpError(409, `session ${params.id} already ended`);
    const e = endSession(Number(params.id), body?.summary ?? {});
    // the final seal is anchored as the session closes; the session is already sealed if the sink fails, and the caller is told
    if (anchorSink) {
      try { const rec = ledger.anchorRecord(Number(params.id)); await anchorSink({ session: rec.session, head_hash: rec.head_hash, seal: rec.seal }); } catch (err) { throw new HttpError(502, `session ended but the anchor sink failed: ${err.message}`); }
    }
    return e;
  });
  route('GET', '/sessions/:id/events', ({ params, query }) => {
    if (!ledger.getSession(params.id)) throw new HttpError(404, `no such session ${params.id}`);
    return ledger.events(params.id, { hydrate: query.get('hydrate') === '1' });
  });

  route('POST', '/command', async ({ body }) => {
    const agent = body.agent ?? 'default';
    const sessionId = body.sessionId ?? ledger.activeSession(agent)?.id;
    if (!sessionId) throw new HttpError(409, `no active session for agent "${agent}"`);
    if (!body.type) throw new HttpError(400, 'type is required');
    return runCommand({ sessionId, type: body.type, params: body.params ?? {}, actor: body.actor ?? 'agent' });
  });

  route('GET', '/gate/pending', () => approvals.list());
  route('POST', '/gate/:id/approve', ({ params, body }) => {
    const r = approvals.decide(params.id, true, body ?? {});
    if (!r.ok) throw new HttpError(r.status, r.error);
    return { approved: params.id };
  });
  route('POST', '/gate/:id/deny', ({ params, body }) => {
    const r = approvals.decide(params.id, false, body ?? {});
    if (!r.ok) throw new HttpError(r.status, r.error);
    return { denied: params.id };
  });

  route('POST', '/checkpoint', async ({ body }) => {
    const agent = body?.agent ?? 'default';
    const s = ledger.activeSession(agent);
    if (!s) throw new HttpError(409, `no active session for agent "${agent}"`);
    const e = await checkpoint(s.id, body?.label ?? 'manual');
    return { idx: e.idx, hash: e.hash };
  });

  route('GET', '/sessions/:id/verify', ({ params, query }) => {
    if (!ledger.getSession(params.id)) throw new HttpError(404, `no such session ${params.id}`);
    return ledger.verifySessionId(Number(params.id), { strict: query.get('strict') === '1' });
  });
  // Key lifecycle. The new key is written to disk BEFORE the ledger switches to it, and the old file is put back if the
  // switch fails, so a restart never ends up with a key file that disagrees with what the ledger last signed with.
  route('POST', '/key/rotate', () => {
    const previous = ledger.key;
    const next = generateKey();
    if (keyPath) saveKey(keyPath, next);
    let cert;
    try { cert = ledger.rotateKey(next); } catch (e) { if (keyPath) saveKey(keyPath, previous); throw new HttpError(409, e.message); }
    return { cert, fingerprint: fingerprint(next.publicKey), previous: fingerprint(previous.publicKey) };
  });
  route('POST', '/key/revoke', ({ body }) => {
    if (typeof body?.fingerprint !== 'string' || !/^[0-9a-f]{16}$/.test(body.fingerprint)) throw new HttpError(400, 'body.fingerprint must be a 16-hex key fingerprint');
    try { return ledger.revokeKey(body.fingerprint); } catch (e) { throw new HttpError(409, e.message); }
  });
  route('POST', '/sessions/:id/verify', ({ params, body }) => {
    if (!ledger.getSession(params.id)) throw new HttpError(404, `no such session ${params.id}`);
    return ledger.verifySessionId(Number(params.id), { strict: !!body?.strict, trustedKey: body?.trustedKey ?? null, trustedKeys: body?.trustedKeys ?? null, trustedApprovers: body?.trustedApprovers ?? null, anchors: body?.anchors ?? null });
  });
  // Returns the record to copy outside the ledger; also hands it to the relay's own sink when one is configured.
  route('POST', '/sessions/:id/anchor', async ({ params }) => {
    if (!ledger.getSession(params.id)) throw new HttpError(404, `no such session ${params.id}`);
    let rec;
    try { rec = ledger.anchorRecord(Number(params.id)); } catch (e) { throw new HttpError(409, e.message); }
    if (anchorSink) {
      try { await anchorSink({ session: rec.session, head_hash: rec.head_hash, seal: rec.seal }); } catch (e) { throw new HttpError(502, `anchor sink failed: ${e.message}`); }
    }
    return { ...rec, sunk: !!anchorSink };
  });
  route('GET', '/sessions/:id/bundle', ({ params }) => {
    if (!ledger.getSession(params.id)) throw new HttpError(404, `no such session ${params.id}`);
    return ledger.bundle(Number(params.id));
  });

  installAnalysisRoutes({ route, api, HttpError });
  installDashboardRoutes({ route, api, HttpError });

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { throw new HttpError(400, 'body is not valid JSON'); }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, payload) => {
      const text = JSON.stringify(payload);
      res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
      res.end(text);
    };
    if (!hostAllowed(req.headers.host)) { res.writeHead(421, { 'content-type': 'text/plain' }); res.end('witnessloop serves loopback hosts only'); return; }
    if (req.method === 'GET' && (url.pathname === '/dashboard' || url.pathname === '/dashboard/')) {
      const html = fs.readFileSync(DASHBOARD_HTML);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': html.length, 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" });
      res.end(html);
      return;
    }
    try {
      // every route, including /health, needs the token; only the static dashboard page above is open (it carries no data)
      if (!originAllowed(req.headers.origin, req.headers.host)) throw new HttpError(403, `cross-origin request refused (Origin ${req.headers.origin})`);
      if (!tokenMatches(token, bearerOf(req.headers.authorization))) throw new HttpError(401, 'missing or invalid relay token (Authorization: Bearer <token>)');
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) throw new HttpError(404, `no route ${req.method} ${url.pathname}`);
      const params = url.pathname.match(r.re).groups ?? {};
      const body = req.method === 'GET' ? null : await readBody(req);
      const result = await r.handler({ params, query: url.searchParams, body });
      send(200, { ok: true, result });
    } catch (e) {
      send(e.status ?? 500, { ok: false, error: e.message, ...(e.extra ? { extra: e.extra } : {}) });
    }
  });

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/agent' || !hostAllowed(req.headers.host)) { socket.destroy(); return; }
    // a browser WebSocket cannot set headers, so the agent presents the token in the query string; checked before the
    // handshake completes, so an unauthenticated socket never registers and never replaces a connected agent
    if (!tokenMatches(token, url.searchParams.get('token'))) { socket.end('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n'); return; }
    const name = url.searchParams.get('name') || 'default';
    const entry = {
      loadId: url.searchParams.get('loadId') || String(Date.now()), origin: url.searchParams.get('origin') || '',
      adapter: url.searchParams.get('adapter') === '1', connectedAt: new Date().toISOString(), conn: null,
    };
    const conn = acceptWebSocket(req, socket, {
      onMessage: (text) => handleAgentMessage(conn, text),
      onClose: () => {
        if (agents.get(name)?.conn === conn) agents.delete(name);
        for (const [id, p] of pending) if (p.conn === conn) { clearTimeout(p.timer); pending.delete(id); p.reject(Object.assign(new HttpError(409, 'agent disconnected'), { observed: p.observed })); }
      },
    });
    if (!conn) return;
    entry.conn = conn;
    const old = agents.get(name);
    agents.set(name, entry);
    if (old) old.conn.close();
  });

  api.server = server;
  api.port = port;
  api.listen = () => new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { api.port = server.address().port; resolve(api); });
  });
  api.close = async () => {
    approvals.list().forEach((p) => approvals.system(p.id, 'shutdown', 'relay closing'));
    for (const a of agents.values()) a.conn.close();
    await new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); });
    ledger.close();
  };
  return api;
}

// `node src/relay.mjs` starts a relay with env-configured defaults; the CLI's `serve` is the real entry.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const relay = await createRelay({ dbPath: process.env.WITNESSLOOP_DB ?? '.witnessloop/ledger.db', keyPath: process.env.WITNESSLOOP_KEY ?? '.witnessloop/key.json', port: Number(process.env.WITNESSLOOP_PORT) || DEFAULT_PORT });
  writeTokenFile(process.env.WITNESSLOOP_TOKEN_FILE ?? DEFAULT_TOKEN_FILE, relay.token);
  await relay.listen();
  console.log(`witnessloop relay on http://127.0.0.1:${relay.port}`);
}
