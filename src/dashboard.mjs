// Read-only analytics for the dashboard. Everything here is derived from the ledger on request:
// nothing is cached and no "verified" flag is stored, so the integrity view always runs the verifier.
import { canon } from './canon.mjs';
import { verifyBundle } from './ledger.mjs';
import { evaluate, validatePolicy } from './policy.mjs';
import { buildCausal, ancestors } from './causal.mjs';
import { bisect } from './bisect.mjs';
import { comparable, diffWorld } from './world.mjs';

const count = (map, k, n = 1) => { map[k] = (map[k] ?? 0) + n; };
const ms = (a, b) => Math.max(0, Date.parse(b) - Date.parse(a));

// intents -> policy verdict -> human resolution -> released command
export function gateStats(events) {
  const decisionsOf = new Map();
  const released = new Set();
  for (const e of events) {
    if (e.kind === 'decision') {
      const list = decisionsOf.get(e.data.intent_idx) ?? [];
      list.push(e);
      decisionsOf.set(e.data.intent_idx, list);
    }
    if ((e.kind === 'command' || e.kind === 'command.begin') && e.data?.intent_idx != null) released.add(e.data.intent_idx);
  }
  const f = { intents: 0, policyAllow: 0, policyDeny: 0, policyAsk: 0, humanAllow: 0, humanDeny: 0, timeout: 0, released: 0, refused: 0 };
  const latencies = [];
  const intents = [];
  for (const e of events.filter((x) => x.kind === 'intent')) {
    f.intents++;
    const [first, second] = decisionsOf.get(e.idx) ?? [];
    const row = { idx: e.idx, type: e.type, params: e.data?.params ?? null, preview: e.data?.preview ?? null, verdict: first?.data.verdict ?? null, rule: first?.data.rule ?? null, reason: first?.data.reason ?? null, final: null, by: null, approver: null, latencyMs: null };
    if (first?.data.verdict === 'allow') { f.policyAllow++; row.final = 'allow'; row.by = 'policy'; }
    else if (first?.data.verdict === 'deny') { f.policyDeny++; row.final = 'deny'; row.by = 'policy'; }
    else if (first?.data.verdict === 'require_approval') {
      f.policyAsk++;
      if (second) {
        row.final = second.data.verdict; row.by = second.data.by ?? null; row.approver = second.data.approver_fp ?? null; row.latencyMs = ms(e.ts, second.ts);
        if (second.data.by === 'timeout') f.timeout++;
        else if (second.data.verdict === 'allow') f.humanAllow++; else f.humanDeny++;
        latencies.push(row.latencyMs);
      } else row.final = 'pending';
    }
    if (released.has(e.idx)) f.released++;
    else if (row.final === 'deny') f.refused++;
    intents.push(row);
  }
  return { funnel: f, latencies, intents };
}

export function evaluateIntent(policy, e, agent) {
  const d = e.data ?? {};
  return evaluate(policy, { type: e.type, effect: e.effect, params: d.params, preview: d.preview ?? null, target: d.describe?.label ?? null, agent, actor: e.actor });
}

export function whatIf({ ledger, sessionId, current, alternative }) {
  const session = ledger.getSession(sessionId);
  const alt = validatePolicy(alternative);
  const rows = ledger.events(sessionId, { hydrate: true }).filter((e) => e.kind === 'intent').map((e) => {
    const a = evaluateIntent(current, e, session.agent);
    const b = evaluateIntent(alt, e, session.agent);
    return { idx: e.idx, params: e.data?.params ?? null, preview: e.data?.preview ?? null, current: a.verdict, currentReason: a.reason, alternative: b.verdict, alternativeReason: b.reason, changed: a.verdict !== b.verdict };
  });
  return { session: sessionId, intents: rows.length, changed: rows.filter((r) => r.changed).length, rows };
}

function repeats(events) {
  const seen = new Map();
  for (const e of events.filter((x) => x.kind === 'intent')) {
    const k = canon({ type: e.type, params: e.data?.params, preview: e.data?.preview ?? null });
    seen.set(k, [...(seen.get(k) ?? []), e.idx]);
  }
  return [...seen.values()].filter((l) => l.length > 1).map((idxs) => { const d = events.find((e) => e.idx === idxs[0]).data; return { intents: idxs, params: d?.params, preview: d?.preview ?? null }; });
}

// Runs the real verifier. `unsealedTail` is the count of events after the last seal: the window
// in which truncation would go undetected.
export function integrity(ledger, sessionId) {
  const t0 = performance.now();
  const v = ledger.verifySessionId(sessionId, { strict: false });
  const strict = ledger.verifySessionId(sessionId, { strict: true });
  const verifyMs = performance.now() - t0;
  return {
    ok: v.ok, strictOk: strict.ok, checked: v.checked, badIdx: v.badIdx, problems: v.problems, warnings: v.warnings, ended: v.ended,
    sealedThrough: v.sealedThrough, unsealedTail: v.checked - 1 - v.sealedThrough, signers: v.signers, verifyMs: +verifyMs.toFixed(2),
  };
}

export function summarize(ledger, session) {
  const events = ledger.events(session.id, { hydrate: true });
  const kinds = {};
  const effects = {};
  let commandMs = 0;
  let bytes = 0;
  let checkpointBytes = 0;
  for (const e of events) {
    count(kinds, e.kind);
    const b = ledger.blobBytes(e.data_hash);
    bytes += b;
    if (e.kind === 'checkpoint') { checkpointBytes += b + ledger.blobBytes(e.data?.world_hash); }
    if (e.kind === 'command') { count(effects, e.effect ?? 'unknown'); commandMs += e.data?.ms ?? 0; }
  }
  const g = gateStats(events);
  const cmds = kinds.command ?? 0;
  return {
    id: session.id, goal: session.goal, actor: session.actor, agent: session.agent, status: session.status, parent: session.parent_session,
    createdAt: session.created_at, events: events.length, kinds, effects, commands: cmds,
    irreversibleShare: cmds ? (effects.irreversible ?? 0) / cmds : 0,
    funnel: g.funnel, flags: kinds.flag ?? 0, repeatedIntents: repeats(events).length,
    cost: { commandMs, avgCommandMs: cmds ? +(commandMs / cmds).toFixed(2) : 0, eventBytes: bytes, checkpointBytes, bytesPerEvent: events.length ? Math.round(bytes / events.length) : 0 },
    integrity: integrity(ledger, session.id),
  };
}

// Sessions grouped by acting agent: the comparison the paper's evaluation needs, from recorded facts only.
export function fleet(sessions) {
  const by = {};
  for (const s of sessions) {
    const a = (by[s.actor] ??= { actor: s.actor, sessions: 0, commands: 0, irreversible: 0, intents: 0, policyDeny: 0, humanDeny: 0, timeout: 0, flags: 0, repeatedIntents: 0, tampered: 0 });
    a.sessions++; a.commands += s.commands; a.irreversible += s.effects.irreversible ?? 0; a.intents += s.funnel.intents;
    a.policyDeny += s.funnel.policyDeny; a.humanDeny += s.funnel.humanDeny; a.timeout += s.funnel.timeout;
    a.flags += s.flags; a.repeatedIntents += s.repeatedIntents; if (!s.integrity.ok) a.tampered++;
  }
  return Object.values(by).map((a) => ({ ...a, irreversibleShare: a.commands ? a.irreversible / a.commands : 0, denyRate: a.intents ? (a.policyDeny + a.humanDeny + a.timeout) / a.intents : 0 }));
}

export function overview(api) {
  const { ledger } = api;
  const sessions = ledger.listSessions().map((s) => summarize(ledger, s));
  // forks and replay-verify sessions re-execute a parent's intents on a shadow: counting them would double count
  const intents = ledger.listSessions().filter((s) => s.parent_session == null).flatMap((s) => ledger.events(s.id, { hydrate: true }).filter((e) => e.kind === 'intent').map((e) => ({ e, agent: s.agent })));
  const policy = api.getPolicy();
  const hits = policy.rules?.map((r, i) => ({ index: i, reason: r.reason ?? `rule ${i}`, then: r.then, hits: 0 })) ?? [];
  const dflt = { index: null, reason: 'policy default', then: policy.default ?? 'require_approval', hits: 0 };
  for (const { e, agent } of intents) {
    const v = evaluateIntent(policy, e, agent);
    if (v.rule === null) dflt.hits++; else hits[v.rule].hits++;
  }
  return { sessions, fleet: fleet(sessions.filter((s) => s.parent == null)), policy, ruleHits: [...hits, dflt], hasInvariant: typeof api.profile.invariant === 'function' };
}

export async function sessionDetail(api, sessionId) {
  const { ledger, profile, volatileKeys } = api;
  const session = ledger.getSession(sessionId);
  const events = ledger.events(sessionId, { hydrate: true });
  const summary = summarize(ledger, session);
  const g = gateStats(events);
  const graph = buildCausal(events);

  const timeline = events.map((e) => ({
    idx: e.idx, ts: e.ts, kind: e.kind, type: e.type, effect: e.effect, ok: e.ok === null ? null : !!e.ok, actor: e.actor,
    verdict: e.data?.verdict ?? null, by: e.data?.by ?? null, label: e.data?.label ?? null, why: e.data?.why ?? null,
    params: e.kind === 'command' || e.kind === 'command.begin' || e.kind === 'intent' ? e.data?.params ?? null : null, preview: e.data?.preview ?? null,
    error: e.data?.error ?? null, ms: e.data?.ms ?? null,
  }));

  const checkpoints = events.filter((e) => e.kind === 'checkpoint').map((e) => ({ idx: e.idx, label: e.data.label, afterIdx: e.data.after_idx, stateHash: e.data.state_hash }));
  let bisectResult = null;
  let invariantSeries = null;
  let worldSeries = null;
  if (typeof profile.metrics === 'function' && checkpoints.length) {
    worldSeries = [];
    for (const cp of checkpoints) {
      const world = ledger.getBlob(events.find((e) => e.idx === cp.idx).data.world_hash);
      try { worldSeries.push({ idx: cp.idx, afterIdx: cp.afterIdx, ...(await profile.metrics(world)) }); } catch { /* a bad snapshot must not take the page down */ }
    }
  }
  if (typeof profile.invariant === 'function' && checkpoints.length) {
    invariantSeries = [];
    for (const cp of checkpoints) {
      const world = ledger.getBlob(events.find((e) => e.idx === cp.idx).data.world_hash);
      const r = await profile.invariant(world);
      invariantSeries.push({ idx: cp.idx, afterIdx: cp.afterIdx, ok: !!r.ok, why: r.why ?? null });
    }
    bisectResult = await bisect({ ledger, sessionId, invariant: profile.invariant, search: 'linear', volatileKeys });
  }

  return {
    summary, gate: g, timeline, checkpoints, invariantSeries, worldSeries, bisect: bisectResult, causal: graph,
    repeats: repeats(events), children: ledger.listSessions().filter((s) => s.parent_session === sessionId).map((s) => ({ id: s.id, goal: s.goal, status: s.status })),
    parent: session.parent_session,
  };
}

export function ancestorsOf(api, sessionId, idx) {
  return ancestors(buildCausal(api.ledger.events(sessionId, { hydrate: true })), idx);
}

export function checkpointDiff(api, sessionId, cpIdx) {
  const { ledger, volatileKeys } = api;
  const cps = ledger.events(sessionId, { hydrate: true }).filter((e) => e.kind === 'checkpoint');
  const i = cps.findIndex((e) => e.idx === cpIdx);
  if (i < 0) return null;
  const cur = ledger.getBlob(cps[i].data.world_hash);
  if (i === 0) return { idx: cpIdx, previousIdx: null, diff: [], note: 'genesis checkpoint has no predecessor' };
  const prev = ledger.getBlob(cps[i - 1].data.world_hash);
  return { idx: cpIdx, previousIdx: cps[i - 1].idx, afterIdx: cps[i].data.after_idx, diff: diffWorld(comparable(prev, volatileKeys), comparable(cur, volatileKeys)) };
}

// Damages a COPY of the exported bundle and reports what the verifier says. Nothing is written back.
export function tamperDemo(ledger, sessionId, { mode = 'payload', idx = null } = {}) {
  const bundle = ledger.bundle(sessionId);
  const before = verifyBundle(bundle, { strict: true });
  const forged = JSON.parse(JSON.stringify(bundle));
  let target = null;
  let what = '';
  if (mode === 'payload') {
    const victim = (idx !== null ? forged.events.find((e) => e.idx === idx) : forged.events.find((e) => e.kind === 'command' && e.data_hash)) ?? forged.events.find((e) => e.data_hash);
    if (!victim?.data_hash) return { error: 'no payload to tamper with' };
    const b = forged.blobs[victim.data_hash];
    const at = Math.max(1, b.length >> 1);
    forged.blobs[victim.data_hash] = b.slice(0, at) + (b[at] === 'x' ? 'y' : 'x') + b.slice(at + 1);
    target = victim.idx; what = `changed one byte of the payload of event #${victim.idx} (${victim.kind})`;
  } else if (mode === 'truncate') {
    if (forged.events.length < 3) return { error: 'session too short to truncate' };
    const cut = forged.events.length - 2;
    forged.events = forged.events.slice(0, cut);
    target = cut; what = 'dropped the last 2 events and left the seals in place';
  } else if (mode === 'delete') {
    if (forged.events.length < 4) return { error: 'session too short' };
    const gone = Math.floor(forged.events.length / 2);
    forged.events.splice(gone, 1);
    target = gone; what = `deleted event #${gone} from the middle of the chain`;
  } else return { error: `unknown mode "${mode}"` };
  const after = verifyBundle(forged, { strict: true });
  return { mode, what, before: { ok: before.ok }, after: { ok: after.ok, badIdx: after.badIdx, problems: after.problems.slice(0, 4) }, detected: !after.ok, targetIdx: target };
}

export function installDashboardRoutes({ route, api, HttpError }) {
  const need = (id) => {
    if (!api.ledger.getSession(id)) throw new HttpError(404, `no such session ${id}`);
    return Number(id);
  };
  route('GET', '/dashboard/overview', () => overview(api));
  route('GET', '/dashboard/sessions/:id', ({ params }) => sessionDetail(api, need(params.id)));
  route('GET', '/dashboard/sessions/:id/diff', ({ params, query }) => {
    const d = checkpointDiff(api, need(params.id), Number(query.get('cp')));
    if (!d) throw new HttpError(404, 'no such checkpoint');
    return d;
  });
  route('GET', '/dashboard/sessions/:id/ancestors', ({ params, query }) => ancestorsOf(api, need(params.id), Number(query.get('idx'))));
  route('POST', '/dashboard/sessions/:id/tamper', ({ params, body }) => {
    const r = tamperDemo(api.ledger, need(params.id), { mode: body?.mode ?? 'payload', idx: body?.idx ?? null });
    if (r.error) throw new HttpError(400, r.error);
    return r;
  });
  route('POST', '/dashboard/sessions/:id/whatif', ({ params, body }) => {
    if (!body?.policy) throw new HttpError(400, 'body.policy is required');
    try { return whatIf({ ledger: api.ledger, sessionId: need(params.id), current: api.getPolicy(), alternative: body.policy }); } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, e.message); }
  });
}
