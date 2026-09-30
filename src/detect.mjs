// Offline detection over a recorded session: a click the gate treated as reversible whose recorded consequences look
// external. This is DETECTION AFTER THE FACT, never prevention: the click already ran when it is found.
//   server_state_changed  the app server's own state (adapter) differs between the checkpoint before the click and the
//                         one right after it. A reversible click is supposed to touch page storage only.
//   observed_request      the page's observer saw a non-GET request during the click (the live flag of 2.2, re-derived
//                         here so a session recorded without a live flag is still covered)
// Heuristics: page-only storage changes are what "reversible" means and are not flagged; a session with no server
// adapter or without post-write checkpoints cannot be checked and says so in `skipped`.
import { comparable, diffWorld } from './world.mjs';

export const AFTER_THE_FACT = 'Detection after the fact, not prevention: these clicks already ran. The gate did not see them.';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function detectUnannotated({ events, getBlob, volatileKeys = [] }) {
  const flagged = new Set(events.filter((e) => e.kind === 'flag' && e.type === 'undeclared_effect').map((e) => e.data?.command_idx));
  const cps = events.filter((e) => e.kind === 'checkpoint');
  const detections = [];
  const skipped = [];
  let checked = 0;
  for (const c of events) {
    if (c.kind !== 'command' || c.type !== 'dom.click' || c.effect !== 'reversible' || !c.ok) continue;
    checked++;
    const found = { command_idx: c.idx, params: c.data?.params ?? null, also_flagged_live: flagged.has(c.idx), confidence: 'heuristic' };

    const writes = (c.data?.result?.observed_effects ?? c.data?.observed_effects ?? []).filter((x) => !SAFE.has(String(x?.method).toUpperCase()));
    if (writes.length) detections.push({ ...found, kind: 'observed_request', evidence: writes });

    const before = [...cps].reverse().find((k) => k.idx < c.idx);
    const post = cps.find((k) => k.data?.after_idx === c.idx);
    if (!before || !post) { skipped.push({ command_idx: c.idx, reason: 'no checkpoint before and after this click' }); continue; }
    let b; let a;
    try { b = comparable(getBlob(before.data.world_hash), volatileKeys).server; a = comparable(getBlob(post.data.world_hash), volatileKeys).server; } catch { skipped.push({ command_idx: c.idx, reason: 'checkpoint world could not be read' }); continue; }
    if (b === null || a === null) { skipped.push({ command_idx: c.idx, reason: 'no server adapter: server state is not recorded' }); continue; }
    const diff = diffWorld(b, a, 20);
    if (diff.length) detections.push({ ...found, kind: 'server_state_changed', paths: diff.map((d) => d.path), evidence: diff });
  }
  return { detections, checked, skipped, note: AFTER_THE_FACT };
}
