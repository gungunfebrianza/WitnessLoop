// "Failure becomes a bug, not an incident": find the FIRST recorded event after which an
// app-defined invariant stops holding. Each state-changing event is followed by a checkpoint, so
// this evaluates the invariant on stored worlds; nothing is re-executed.
//   linear  checks every checkpoint in order (always right)
//   binary  O(log n) evaluations; assumes breakage is monotone (once broken, stays broken)
import { buildCausal, ancestors } from './causal.mjs';
import { comparable, diffWorld } from './world.mjs';

export async function bisect({ ledger, sessionId, invariant, search = 'linear', volatileKeys = [] }) {
  if (typeof invariant !== 'function') throw new Error('bisect needs an invariant(world) function (the app profile provides one)');
  const events = ledger.events(sessionId, { hydrate: true });
  const cps = events.filter((e) => e.kind === 'checkpoint').map((e) => ({ idx: e.idx, label: e.data.label, afterIdx: e.data.after_idx, world: ledger.getBlob(e.data.world_hash) }));
  if (!cps.length) throw new Error('session has no checkpoints to bisect (was it run with checkpoints: none?)');

  let evaluations = 0;
  const cache = new Map();
  const check = async (i) => {
    if (!cache.has(i)) { evaluations++; cache.set(i, await invariant(cps[i].world)); }
    return cache.get(i);
  };
  const result = { search, checkpoints: cps.length, found: false, evaluations: 0 };

  let bad = -1;
  if (!(await check(0)).ok) {
    result.genesisBad = true;
    bad = 0;
  } else if (search === 'binary') {
    if (!(await check(cps.length - 1)).ok) {
      let lo = 0; let hi = cps.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if ((await check(mid)).ok) lo = mid; else hi = mid;
      }
      bad = hi;
    }
  } else {
    for (let i = 1; i < cps.length; i++) if (!(await check(i)).ok) { bad = i; break; }
  }
  result.evaluations = evaluations;
  if (bad < 0) return result;

  const cp = cps[bad];
  const verdict = await check(bad);
  const cmd = events.find((e) => e.idx === cp.afterIdx) ?? null;
  const decisions = cmd?.data?.intent_idx !== undefined ? events.filter((e) => e.kind === 'decision' && e.data.intent_idx === cmd.data.intent_idx) : [];
  const graph = buildCausal(events);
  result.found = true;
  result.firstBad = {
    checkpointIdx: cp.idx,
    commandIdx: cp.afterIdx,
    command: cmd ? { idx: cmd.idx, type: cmd.type, effect: cmd.effect, actor: cmd.actor, params: cmd.data.params, result: cmd.data.result } : null,
    approvedBy: decisions.length ? decisions.at(-1).data.by ?? 'policy' : null,
    why: verdict.why ?? 'invariant failed',
    stateDiff: bad > 0 ? diffWorld(comparable(cps[bad - 1].world, volatileKeys), comparable(cp.world, volatileKeys)) : [],
    causes: cmd ? ancestors(graph, cmd.idx) : [],
  };
  if (bad > 0) result.lastGoodCheckpointIdx = cps[bad - 1].idx;
  return result;
}
