// Fork the past, re-run the future.
//   fork          restore a recorded checkpoint into a SHADOW agent and re-execute the recorded
//                 commands from there, optionally with an override / skip / different policy
//   replayVerify  fork from the start with nothing changed; the claim "this session can be
//                 reproduced" holds only if every step's result and the final world match
//   compare       align two sessions' attempts and find the first divergence
// Shadow-only: production is never re-run. A fork must target a different agent than its parent.
import { canon, hashOf, stripKeys, setPath } from './canon.mjs';
import { comparable, diffWorld, stateHash } from './world.mjs';
import { cleanNondet } from './nondet.mjs';
import { EXTERNAL_NOTE } from './external.mjs';
import { buildDivergences, classCounts } from './classify.mjs';

const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

function lastCheckpointBefore(events, idx) {
  let cp = null;
  for (const e of events) if (e.kind === 'checkpoint' && e.idx < idx) cp = e;
  return cp;
}

// observed_effects carries the page origin, which differs between production and a shadow copy: never part of a replay comparison
// nondet is what the page drew from Date.now / Math.random: recorded in the parent, measured in the shadow, and compared separately
const STRUCTURAL = ['observed_effects', 'nondet', 'external_replay', 'flow']; // 'flow' carries a per-page-load id, which differs on a shadow
const norm = (v, volatileKeys) => hashOf(stripKeys(v, [...(volatileKeys ?? []), ...STRUCTURAL]));
const pathsOf = (a, b, keys) => diffWorld(stripKeys(a, keys), stripKeys(b, keys)).map((d) => d.path);

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
  // Third-party origins the parent recorded: the shadow is switched to serve them from the recording, and never to reach the network.
  // If that cannot be arranged the fork is refused: replaying against the live third party is exactly what this must not do.
  const extOrigins = Array.isArray(events[0].data?.recording?.external) ? events[0].data.recording.external : [];
  const recordedCalls = commands.reduce((n, c) => n + (c.data.external?.length ?? 0), 0);
  const external = { mode: extOrigins.length ? 'recorded' : 'off', origins: extOrigins, recorded_calls: recordedCalls };
  if (extOrigins.length) {
    try { await relay.dispatch(shadowAgent, 'external.arm', { mode: 'replay', origins: extOrigins }); } catch (e) { throw relay.httpError(409, `cannot switch shadow agent "${shadowAgent}" to recorded external responses (${String(e.message).slice(0, 120)}); refusing to replay against the live third party`); }
  }
  // Shadow only: fix the page's clock and dice. Armed BEFORE the restore, which reloads the page, so the shims are in place before its scripts run.
  // The seed comes from the parent's session.start event and is written into fork.start; recorded draws (if the parent recorded them) are fed back per command.
  const startEv = events[0];
  const seed = parseInt(String(startEv.hash).slice(0, 8), 16) >>> 0;
  const base = Date.parse(startEv.ts) || 0;
  const recordedCommands = commands.filter((c) => cleanNondet(c.data.result?.nondet)).length;
  let shims = { seed, base, mode: recordedCommands ? 'recorded' : 'seeded', recorded_commands: recordedCommands };
  try { await relay.dispatch(shadowAgent, 'shim.arm', { seed, base }); } catch (e) { shims = { mode: 'unavailable', reason: String(e.message).slice(0, 200) }; }
  const restoreInfo = await relay.restoreWorld(shadowAgent, world);
  const restoreDrift = restoreInfo?.drift ?? []; // autoIncrement generators that did not come back to what they were

  const forkId = await relay.startSession({ goal: goal ?? `fork of #${sessionId} at event ${from}`, actor, agent: shadowAgent, parent: sessionId, meta: { fork: true } });
  const restored = ledger.events(forkId, { hydrate: true }).find((e) => e.kind === 'checkpoint');
  const anchor = events.find((e) => e.idx === from - 1);
  ledger.append(forkId, {
    kind: 'fork.start', actor,
    data: {
      parent_session: sessionId, parent_head_idx: anchor.idx, parent_head_hash: anchor.hash, at_idx: from,
      checkpoint_idx: cp.idx, checkpoint_state_hash: cp.data.state_hash, restored_state_hash: restored?.data.state_hash ?? null,
      override, skip, policy_hash: policy ? hashOf(policy) : null, restore_drift: restoreDrift, shims, external,
    },
  });
  const restoreVerified = !restored || restored.data.state_hash === cp.data.state_hash;

  const steps = [];
  const stepInfo = []; // what the classifier needs per replayed step
  const parentOrigin = relay.agentInfo?.(parent.agent)?.origin || null;
  for (const c of commands.filter((x) => x.idx >= from)) {
    if (skip.includes(c.idx)) { steps.push({ parentIdx: c.idx, type: c.type, skipped: true, same: false }); continue; }
    const { params, overridden } = applyOverride(c, override);
    let out;
    if (extOrigins.length) {
      const calls = (c.data.external ?? []).map((x) => ({ method: x.method, origin: x.origin, path: x.path, query_hash: x.query_hash, req_hash: x.req_hash, status: x.status, content_type: x.content_type, body_b64: x.response_hash ? ledger.getBlob(x.response_hash)?.body_b64 ?? null : null }));
      await relay.dispatch(shadowAgent, 'external.feed', { calls });
    }
    if (shims.mode !== 'unavailable') {
      const nd = cleanNondet(c.data.result?.nondet);
      await relay.dispatch(shadowAgent, 'shim.feed', { now: nd?.now ?? [], random: nd?.random ?? [] }).catch(() => {});
    }
    try { out = await relay.runCommand({ sessionId: forkId, type: c.type, params, actor, policy, autoApprove }); } catch (e) { out = { ok: false, error: e.message, failed: true }; }
    const parentOutcome = { ok: !!c.ok, result: c.data.result, error: c.data.error };
    const shadowOutcome = { ok: out.ok, result: out.result, error: out.error };
    const same = !out.denied && !out.failed && norm(parentOutcome, volatileKeys) === norm(shadowOutcome, volatileKeys);
    stepInfo.push({
      position: steps.length, parentIdx: c.idx, denied: !!out.denied, failed: !!out.failed, error: out.error,
      paths: out.denied || out.failed ? [] : pathsOf(parentOutcome, shadowOutcome, [...volatileKeys, ...STRUCTURAL]),
      volatilePaths: out.denied || out.failed ? [] : pathsOf(parentOutcome, shadowOutcome, STRUCTURAL),
      nondet: out.result?.nondet, external: out.result?.external_replay, parentObserved: Array.isArray(c.data.result?.observed_effects) ? c.data.result.observed_effects : [],
    });
    steps.push({ parentIdx: c.idx, forkIdx: out.idx ?? null, type: c.type, params, overridden, denied: !!out.denied, reason: out.reason, ok: out.ok, same, ...(out.result?.nondet ? { nondet: out.result.nondet } : {}), ...(out.result?.external_replay ? { external: out.result.external_replay } : {}) });
  }
  if (shims.mode !== 'unavailable') await relay.dispatch(shadowAgent, 'shim.disarm', {}).catch(() => {});
  if (extOrigins.length) await relay.dispatch(shadowAgent, 'external.arm', { mode: 'off', origins: [] }).catch(() => {});
  external.served = steps.reduce((n, s) => n + (s.external?.served ?? 0), 0);
  external.missed = steps.flatMap((s) => (s.external?.missed ?? []).map((m) => ({ parentIdx: s.parentIdx, ...m })));

  const forkEvents = ledger.events(forkId, { hydrate: true });
  const finalOf = (evs) => { const l = evs.filter((e) => e.kind === 'checkpoint').at(-1); return l ? { hash: l.data.state_hash, world: ledger.getBlob(l.data.world_hash) } : null; };
  const pf = finalOf(events);
  const ff = finalOf(forkEvents);
  relay.endSession(forkId, { fork_of: sessionId, at_idx: from, steps: steps.length });
  const finalState = {
    parent: pf?.hash ?? null, fork: ff?.hash ?? null, same: !!pf && !!ff && pf.hash === ff.hash,
    diff: pf && ff ? diffWorld(comparable(pf.world, volatileKeys), comparable(ff.world, volatileKeys)) : [],
  };
  // Every difference from the recording is labelled, with its evidence. A counterfactual fork (steps skipped or params overridden) differs on purpose, so it is not classified.
  const counterfactual = skip.length > 0 || Object.keys(override).length > 0;
  const finalRaw = pf && ff ? diffWorld(comparable(pf.world, []), comparable(ff.world, [])).map((d) => d.path) : [];
  const divergences = counterfactual ? [] : buildDivergences({
    volatileKeys, externalMode: external.mode, parentOrigin, restore: { verified: restoreVerified, drift: restoreDrift }, steps: stepInfo,
    final: { paths: finalState.diff.map((d) => d.path), volatilePaths: finalState.same ? finalRaw : [], missing: !finalState.same && !finalState.diff.length },
  });
  return {
    forkSession: forkId, parentSession: sessionId, atIdx: from, restoreVerified, restoreDrift, shims, external, counterfactual, divergences, classes: counterfactual ? null : classCounts(divergences),
    ...(external.mode === 'recorded' ? { replayedAgainstRecordedExternal: true, note: EXTERNAL_NOTE } : {}), steps,
    firstDivergence: steps.find((s) => !s.same) ?? null, finalState,
  };
}

export async function replayVerify(relay, { sessionId, shadowAgent, actor = 'verifier' }) {
  const r = await fork(relay, {
    sessionId, shadowAgent, actor, policy: { default: 'allow', rules: [] }, autoApprove: true,
    goal: `replay-verify of #${sessionId}`,
  });
  return {
    // reproduced only if nothing differs except inside declared volatile keys (those are listed, not hidden)
    reproduced: r.restoreVerified && r.steps.every((s) => s.same) && r.finalState.same && r.divergences.every((d) => d.ok),
    divergences: r.divergences, classes: r.classes,
    steps: r.steps.length, restoreVerified: r.restoreVerified, restoreDrift: r.restoreDrift, shims: r.shims, external: r.external,
    ...(r.replayedAgainstRecordedExternal ? { replayedAgainstRecordedExternal: true, note: r.note } : {}), firstDivergence: r.firstDivergence, finalState: r.finalState, forkSession: r.forkSession,
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
