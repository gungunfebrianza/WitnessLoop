// Causal graph over one session's events. Edges are { cause, effect, kind, inferred }.
//   recorded (inferred:false)  decided, resolved_by, released, state_after, flagged, retry_of, verifies
//   inferred (inferred:true)   derived_from (a written value first appeared in an earlier read),
//                              observes (a read right after a write, on a different target)
// Inferred edges are heuristics and are labelled as such; nothing downstream presents them as proof.
import { canon } from './canon.mjs';

const SKIP_KEYS = new Set(['selector', 'nth', 'timeoutMs', 'ms', 'text', 'gone']);

function scalars(value, path = '', out = []) {
  if (value === null || value === undefined) return out;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') { out.push({ path, text: String(value) }); return out; }
  if (Array.isArray(value)) { value.forEach((v, i) => scalars(v, `${path}[${i}]`, out)); return out; }
  if (typeof value === 'object') for (const [k, v] of Object.entries(value)) scalars(v, path ? `${path}.${k}` : k, out);
  return out;
}

function paramScalars(params) {
  const out = [];
  for (const [k, v] of Object.entries(params ?? {})) if (!SKIP_KEYS.has(k)) scalars(v, k, out);
  return out;
}

export function buildCausal(events) {
  const nodes = [];
  const edges = [];
  const add = (cause, effect, kind, inferred = false, detail = null) => {
    if (cause === effect || cause === undefined || effect === undefined) return;
    if (edges.some((e) => e.cause === cause && e.effect === effect && e.kind === kind && canon(e.detail) === canon(detail))) return;
    edges.push({ cause, effect, kind, inferred, ...(detail ? { detail } : {}) });
  };

  const commands = [];
  const lastDecisionFor = new Map();
  for (const e of events) {
    if (!['intent', 'decision', 'command', 'flag', 'checkpoint'].includes(e.kind)) continue;
    nodes.push({ idx: e.idx, kind: e.kind, type: e.type ?? null, effect: e.effect ?? null, ok: e.ok === null ? null : !!e.ok });
    const d = e.data ?? {};
    if (e.kind === 'decision') {
      add(d.intent_idx, e.idx, 'decided');
      if (d.resolves_idx !== undefined) add(d.resolves_idx, e.idx, 'resolved_by');
      if (e.ok) lastDecisionFor.set(d.intent_idx, e.idx);
    }
    if (e.kind === 'command') {
      if (d.intent_idx !== undefined) add(lastDecisionFor.get(d.intent_idx), e.idx, 'released');
      commands.push(e);
    }
    if (e.kind === 'checkpoint' && d.after_idx !== null && d.after_idx !== undefined) add(d.after_idx, e.idx, 'state_after');
    if (e.kind === 'flag') add(d.command_idx, e.idx, 'flagged');
  }

  const reads = [];
  let lastWrite = null;
  commands.forEach((c) => {
    const d = c.data;
    const isRead = c.effect === 'read';
    // retry: same type + same params as an earlier command that failed
    for (let i = commands.indexOf(c) - 1; i >= 0; i--) {
      const p = commands[i];
      if (p.ok === 0 && p.type === c.type && canon(p.data.params) === canon(d.params)) { add(p.idx, c.idx, 'retry_of'); break; }
    }
    if (isRead) {
      if (lastWrite) {
        const sameTarget = lastWrite.data.params?.selector && lastWrite.data.params.selector === d.params?.selector;
        add(lastWrite.idx, c.idx, sameTarget ? 'verifies' : 'observes', !sameTarget);
      }
      reads.push(c);
    } else {
      // provenance: which earlier read first showed the values this write used
      for (const ps of paramScalars(d.params)) {
        if (ps.text.length < 3) continue;
        for (let i = reads.length - 1; i >= 0; i--) {
          const hit = scalars(reads[i].data.result).find((s) => s.text === ps.text || (ps.text.length >= 5 && s.text.includes(ps.text)));
          if (hit) { add(reads[i].idx, c.idx, 'derived_from', true, { param: ps.path, value: ps.text, foundAt: hit.path }); break; }
        }
      }
      lastWrite = c;
    }
  });
  return { nodes, edges };
}

// Everything that (transitively) led to `idx`, nearest first.
export function ancestors(graph, idx) {
  const seen = new Map();
  const queue = [idx];
  while (queue.length) {
    const cur = queue.shift();
    for (const e of graph.edges) {
      if (e.effect !== cur || seen.has(e.cause) || e.cause === idx) continue;
      seen.set(e.cause, { idx: e.cause, via: e.kind, inferred: e.inferred, effect: cur });
      queue.push(e.cause);
    }
  }
  return [...seen.values()];
}
