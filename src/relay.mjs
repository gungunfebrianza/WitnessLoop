// HTTP + WebSocket hub. Agents (browser pages running src/agent/inject.js) connect over WS;
// callers (CLI, MCP, scripts) drive them over HTTP. Every command passes through runCommand(),
// which is where the ledger, the gate and the world checkpoints meet.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ledger } from './ledger.mjs';
import { loadOrCreateKey, generateKey } from './attest.mjs';
import { acceptWebSocket } from './ws.mjs';
import { COMMANDS, classify, timeoutFor } from './registry.mjs';
import { validatePolicy, DEFAULT_POLICY } from './policy.mjs';
import { gate, Approvals } from './gate.mjs';
import { captureWorld, restoreWorld, stateHash } from './world.mjs';
import { installAnalysisRoutes } from './routes-analysis.mjs';

export const DEFAULT_PORT = 8974;

export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

export async function createRelay({
  dbPath = ':memory:', keyPath = null, port = DEFAULT_PORT, host = '127.0.0.1', policy = null, profile = {},
  approvalTimeoutMs = 300000, checkpoints = 'mutating', now,
} = {}) {
  const key = keyPath ? loadOrCreateKey(keyPath) : generateKey();
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const ledger = new Ledger(dbPath, { key, ...(now ? { now } : {}) });
  const approvals = new Approvals({ timeoutMs: approvalTimeoutMs });
  const agents = new Map();
  const pending = new Map();
  let nextId = 0;
  let currentPolicy = validatePolicy(policy ?? DEFAULT_POLICY);
  const volatileKeys = profile.volatileKeys ?? [];

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
  async function checkpoint(sessionId, label, afterIdx = null) {
    const session = ledger.getSession(sessionId);
    const world = await captureWorld(bridge, session.agent);
    const world_hash = ledger.putBlob(world);
    return ledger.append(sessionId, {
      kind: 'checkpoint', actor: 'relay',
      data: { label, after_idx: afterIdx, world_hash, state_hash: stateHash(world, volatileKeys) },
    });
  }

  async function startSession({ goal = '', actor = 'agent', agent = 'default', parent = null, meta = {} } = {}) {
    if (!agents.has(agent)) throw new HttpError(409, `agent "${agent}" is not connected`);
    if (ledger.activeSession(agent)) throw new HttpError(409, `agent "${agent}" already has an active session`);
    const id = ledger.startSession({ goal, actor, agent, parent, meta });
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

    const t0 = Date.now();
    let result;
    let error;
    try { result = await dispatch(agent, type, params); } catch (e) { error = e.message; }
    const cmd = ledger.append(sessionId, {
      kind: 'command', actor, type, effect, ok: !error,
      data: { params, ...(describe ? { describe } : {}), ...(intentIdx !== null ? { intent_idx: intentIdx } : {}), result, error, ms: Date.now() - t0 },
    });

    let after = null;
    const wantsCheckpoint = effect !== 'read' && (checkpoints === 'mutating' || (checkpoints === 'irreversible' && effect === 'irreversible'));
    if (wantsCheckpoint || (effect === 'irreversible' && profile.effectCheck)) {
      after = await captureWorld(bridge, agent);
      if (wantsCheckpoint) {
        const world_hash = ledger.putBlob(after);
        ledger.append(sessionId, { kind: 'checkpoint', actor: 'relay', data: { label: 'post', after_idx: cmd.idx, world_hash, state_hash: stateHash(after, volatileKeys) } });
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
    ledger, approvals, profile, bridge, volatileKeys, agents,
    dispatch, agentInfo, waitForReconnect, checkpoint, startSession, endSession, runCommand,
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
  route('POST', '/sessions/:id/end', ({ params, body }) => {
    const s = ledger.getSession(params.id);
    if (!s) throw new HttpError(404, `no such session ${params.id}`);
    if (s.status !== 'active') throw new HttpError(409, `session ${params.id} already ended`);
    return endSession(Number(params.id), body?.summary ?? {});
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
    if (!approvals.resolve(params.id, true, body?.by ?? 'human', body?.reason ?? null)) throw new HttpError(404, `no pending intent ${params.id}`);
    return { approved: params.id };
  });
  route('POST', '/gate/:id/deny', ({ params, body }) => {
    if (!approvals.resolve(params.id, false, body?.by ?? 'human', body?.reason ?? null)) throw new HttpError(404, `no pending intent ${params.id}`);
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
  route('GET', '/sessions/:id/bundle', ({ params }) => {
    if (!ledger.getSession(params.id)) throw new HttpError(404, `no such session ${params.id}`);
    return ledger.bundle(Number(params.id));
  });

  installAnalysisRoutes({ route, api, HttpError });

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
    try {
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
    if (url.pathname !== '/agent') { socket.destroy(); return; }
    const name = url.searchParams.get('name') || 'default';
    const entry = {
      loadId: url.searchParams.get('loadId') || String(Date.now()), origin: url.searchParams.get('origin') || '',
      adapter: url.searchParams.get('adapter') === '1', connectedAt: new Date().toISOString(), conn: null,
    };
    const conn = acceptWebSocket(req, socket, {
      onMessage: (text) => handleAgentMessage(conn, text),
      onClose: () => {
        if (agents.get(name)?.conn === conn) agents.delete(name);
        for (const [id, p] of pending) if (p.conn === conn) { clearTimeout(p.timer); pending.delete(id); p.reject(new HttpError(409, 'agent disconnected')); }
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
    approvals.list().forEach((p) => approvals.resolve(p.id, false, 'shutdown', 'relay closing'));
    for (const a of agents.values()) a.conn.close();
    await new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); });
    ledger.close();
  };
  return api;
}

// `node src/relay.mjs` starts a relay with env-configured defaults; the CLI's `serve` is the real entry.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const relay = await createRelay({ dbPath: process.env.WITNESSLOOP_DB ?? '.witnessloop/ledger.db', keyPath: process.env.WITNESSLOOP_KEY ?? '.witnessloop/key.json', port: Number(process.env.WITNESSLOOP_PORT) || DEFAULT_PORT });
  await relay.listen();
  console.log(`witnessloop relay on http://127.0.0.1:${relay.port}`);
}
