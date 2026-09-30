// Fork the past, re-run the future.
//   fork          restore a recorded checkpoint into a SHADOW agent and re-execute the recorded
//                 commands from there, optionally with an override / skip / different policy
//   replayVerify  fork from the start with nothing changed; the claim "this session can be
//                 reproduced" holds only if every step's result and the final world match
//   compare       align two sessions' attempts and find the first divergence
// Shadow-only: production is never re-run. A fork must target a different agent than its parent.
import { canon, hashOf, stripKeys, setPath } from './canon.mjs';
import { comparable, diffWorld, stateHash } from './world.mjs';

const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

function lastCheckpointBefore(events, idx) {
  let cp = null;
  for (const e of events) if (e.kind === 'checkpoint' && e.idx < idx) cp = e;
  return cp;
}

// observed_effects carries the page origin, which differs between production and a shadow copy: never part of a replay comparison
const norm = (v, volatileKeys) => hashOf(stripKeys(v, [...(volatileKeys ?? []), 'observed_effects']));

// override: { "<eventIdx>": { "params.amount": "50" } }  (dotted paths into the recorded data)
function applyOverride(c, override) {
  const spec = override?.[String(c.idx)];
  const wrapper = { params: clone(c.data.params ?? {}) };
  if (!spec) return { params: wrapper.params, overridden: false };
  for (const [path, value] of Object.entries(spec)) setPath(wrapper, path.startsWith('params.') ? path : `params.${path}`, value);
  return { params: wrapper.params, overridden: true };
}

export async function fork(relay, {
  sessionId, atIdx, shadowAgent, override = {}, skip = [], policy = null, actor = 'fork',
  forceSame = false, autoApprove = true, goal = null,
}) {
  const { ledger, volatileKeys } = relay;
  const parent = ledger.getSession(sessionId);
  if (!parent) throw relay.httpError(404, `no such session ${sessionId}`);
  if (!shadowAgent) throw relay.httpError(400, 'fork needs a shadow agent');
  if (parent.agent === shadowAgent && !forceSame) {
    throw relay.httpError(409, `shadow agent "${shadowAgent}" is the agent the parent session ran on; forks never re-run production (pass forceSame to override)`);
  }
  const events = ledger.events(sessionId, { hydrate: true });
  const commands = events.filter((e) => e.kind === 'command');
  const from = atIdx ?? commands[0]?.idx ?? events.length;
  const cp = lastCheckpointBefore(events, from);
  if (!cp) throw relay.httpError(409, `session ${sessionId} has no checkpoint before event ${from}, so there is nothing to fork from`);
  if (from < 1) throw relay.httpError(400, 'cannot fork at the session start event');

  const world = ledger.getBlob(cp.data.world_hash);
  await relay.restoreWorld(shadowAgent, world);

  const forkId = await relay.startSession({ goal: goal ?? `fork of #${sessionId} at event ${from}`, actor, agent: shadowAgent, parent: sessionId, meta: { fork: true } });
  const restored = ledger.events(forkId, { hydrate: true }).find((e) => e.kind === 'checkpoint');
  const anchor = events.find((e) => e.idx === from - 1);
  ledger.append(forkId, {
    kind: 'fork.start', actor,
    data: {
      parent_session: sessionId, parent_head_idx: anchor.idx, parent_head_hash: anchor.hash, at_idx: from,
      checkpoint_idx: cp.idx, checkpoint_state_hash: cp.data.state_hash, restored_state_hash: restored?.data.state_hash ?? null,
      override, skip, policy_hash: policy ? hashOf(policy) : null,
    },
  });
  const restoreVerified = !restored || restored.data.state_hash === cp.data.state_hash;

  const steps = [];
  for (const c of commands.filter((x) => x.idx >= from)) {
    if (skip.includes(c.idx)) { steps.push({ parentIdx: c.idx, type: c.type, skipped: true, same: false }); continue; }
    const { params, overridden } = applyOverride(c, override);
    let out;
    try { out = await relay.runCommand({ sessionId: forkId, type: c.type, params, actor, policy, autoApprove }); } catch (e) { out = { ok: false, error: e.message, failed: true }; }
    const same = !out.denied && !out.failed
      && norm({ ok: !!c.ok, result: c.data.result, error: c.data.error }, volatileKeys) === norm({ ok: out.ok, result: out.result, error: out.error }, volatileKeys);
    steps.push({ parentIdx: c.idx, forkIdx: out.idx ?? null, type: c.type, params, overridden, denied: !!out.denied, reason: out.reason, ok: out.ok, same });
  }

  const forkEvents = ledger.events(forkId, { hydrate: true });
  const finalOf = (evs) => { const l = evs.filter((e) => e.kind === 'checkpoint').at(-1); return l ? { hash: l.data.state_hash, world: ledger.getBlob(l.data.world_hash) } : null; };
  const pf = finalOf(events);
  const ff = finalOf(forkEvents);
  relay.endSession(forkId, { fork_of: sessionId, at_idx: from, steps: steps.length });
  const finalState = {
    parent: pf?.hash ?? null, fork: ff?.hash ?? null, same: !!pf && !!ff && pf.hash === ff.hash,
    diff: pf && ff ? diffWorld(comparable(pf.world, volatileKeys), comparable(ff.world, volatileKeys)) : [],
  };
  return {
    forkSession: forkId, parentSession: sessionId, atIdx: from, restoreVerified, steps,
    firstDivergence: steps.find((s) => !s.same) ?? null, finalState,
  };
}

export async function replayVerify(relay, { sessionId, shadowAgent, actor = 'verifier' }) {
  const r = await fork(relay, {
    sessionId, shadowAgent, actor, policy: { default: 'allow', rules: [] }, autoApprove: true,
    goal: `replay-verify of #${sessionId}`,
  });
  return {
    reproduced: r.restoreVerified && r.steps.every((s) => s.same) && r.finalState.same,
    steps: r.steps.length, restoreVerified: r.restoreVerified, firstDivergence: r.firstDivergence, finalState: r.finalState, forkSession: r.forkSession,
  };
}

// An "attempt" is a command that ran, or an irreversible intent that was refused.
function attempts(events, volatileKeys) {
  // a begin without a result was still dispatched: it is not a refusal (verify reports it as unresolved)
  const ran = new Set(events.filter((e) => (e.kind === 'command' || e.kind === 'command.begin') && e.data.intent_idx !== undefined && e.data.intent_idx !== null).map((e) => e.data.intent_idx));
  const out = [];
  for (const e of events) {
    if (e.kind === 'command') out.push({ idx: e.idx, type: e.type, params: e.data.params, denied: false, outcome: norm({ ok: !!e.ok, result: e.data.result, error: e.data.error }, volatileKeys) });
    else if (e.kind === 'intent' && !ran.has(e.idx)) out.push({ idx: e.idx, type: e.type, params: e.data.params, denied: true, outcome: 'denied' });
  }
  return out;
}

export function compare(relay, a, b) {
  const { ledger, volatileKeys } = relay;
  const ea = ledger.events(a, { hydrate: true });
  const eb = ledger.events(b, { hydrate: true });
  const xa = attempts(ea, volatileKeys);
  const xb = attempts(eb, volatileKeys);
  let firstDivergence = null;
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    const p = xa[i];
    const q = xb[i];
    let reason = null;
    if (!p || !q) reason = 'one session has more steps';
    else if (p.type !== q.type || canon(p.params) !== canon(q.params)) reason = 'different command or parameters';
    else if (p.denied !== q.denied) reason = q.denied ? 'refused in the second session' : 'refused in the first session';
    else if (p.outcome !== q.outcome) reason = 'different outcome';
    if (reason) { firstDivergence = { position: i, reason, a: p ?? null, b: q ?? null }; break; }
  }
  const last = (evs) => { const l = evs.filter((e) => e.kind === 'checkpoint').at(-1); return l ? ledger.getBlob(l.data.world_hash) : null; };
  const wa = last(ea);
  const wb = last(eb);
  return {
    a, b, attemptsA: xa.length, attemptsB: xb.length, firstDivergence,
    finalState: { same: !!wa && !!wb && stateHash(wa, volatileKeys) === stateHash(wb, volatileKeys), diff: wa && wb ? diffWorld(comparable(wa, volatileKeys), comparable(wb, volatileKeys)) : [] },
  };
}
