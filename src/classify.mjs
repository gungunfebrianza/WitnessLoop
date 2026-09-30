// Every way a replay differed from its recording, labelled, with the evidence that justifies the label.
//   volatile          the difference lies wholly inside a key the app declared volatile (ok: reported, does not fail the replay)
//   nondeterministic  the page drew clock/random values the recording did not hold, or an IndexedDB key generator could not be rewound
//   external          a third-party request had no recorded response, or the recorded step reached a foreign origin nobody recorded
//   unknown           anything else. Not guessed at: nothing is called "ok" unless it is inside a declared volatile key.
// Pure: replay.mjs hands in the diffs and what the shadow page reported; nothing here touches a page or a ledger.
export const CLASSES = ['volatile', 'nondeterministic', 'external', 'unknown'];
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const PRIORITY = ['external', 'nondeterministic']; // the most specific mechanism wins; every piece of evidence is still listed

const pathIn = (p, db, store) => p === `indexedDB.${db}.stores.${store}` || p.startsWith(`indexedDB.${db}.stores.${store}.`);

// Are all of these paths inside a declared volatile key? (an empty list is not volatile: there is nothing to vouch for)
export const allVolatile = (paths, volatileKeys) => paths.length > 0 && paths.every((p) => p.split('.').some((seg) => volatileKeys.includes(seg)));

function nondetEvidence(step) {
  const n = step?.nondet;
  if (!n || !n.used || !n.fed) return [];
  const out = [];
  for (const [kind, label] of [['now', 'clock value(s) (Date.now / new Date)'], ['random', 'Math.random value(s)']]) {
    const used = Number(n.used[kind]) || 0;
    const fed = Number(n.fed[kind]) || 0;
    if (used > fed) out.push({ class: 'nondeterministic', what: `the page drew ${used - fed} ${label} that the recording did not hold (step at #${step.parentIdx})` });
    else if (used < fed) out.push({ class: 'nondeterministic', what: `the page drew ${used} ${label} where the recording holds ${fed} (step at #${step.parentIdx})` });
  }
  return out;
}

function externalEvidence(step, { externalMode, parentOrigin }) {
  const out = [];
  for (const m of step?.external?.missed ?? []) out.push({ class: 'external', what: `no recorded response for ${m.method} ${m.origin ?? ''}${m.path ?? ''} (${m.reason ?? 'not recorded'}) (step at #${step.parentIdx})` });
  if (externalMode !== 'recorded') {
    for (const x of step?.parentObserved ?? []) {
      if (x && x.origin && parentOrigin && x.origin !== parentOrigin && !SAFE.has(String(x.method).toUpperCase())) {
        out.push({ class: 'external', what: `the recorded step sent ${x.method} ${x.origin}${x.path ?? ''} to a foreign origin whose response was not recorded (step at #${step.parentIdx})` });
      }
    }
  }
  return out;
}

const driftEvidence = (drift, paths) => (drift ?? [])
  .filter((d) => paths === null || paths.some((p) => pathIn(p, d.db, d.store)))
  .map((d) => ({ class: 'nondeterministic', what: `IndexedDB ${d.db}/${d.store}: the autoIncrement key generator is at ${d.actual} after restore, not the recorded ${d.expected}` }));

function label(evidence) {
  for (const c of PRIORITY) if (evidence.some((e) => e.class === c)) return c;
  return 'unknown';
}

// input: { volatileKeys, externalMode, parentOrigin,
//          restore: { verified, drift }, steps: [{ position, parentIdx, denied, failed, error, paths, volatilePaths, nondet, external, parentObserved }],
//          final: { paths, volatilePaths } }
export function buildDivergences({ volatileKeys = [], externalMode = 'off', parentOrigin = null, restore = { verified: true, drift: [] }, steps = [], final = { paths: [], volatilePaths: [] } }) {
  const ctx = { externalMode, parentOrigin };
  const out = [];
  const push = (d) => out.push({ ...d, ok: d.class === 'volatile' });

  if (!restore.verified) {
    const evidence = driftEvidence(restore.drift, null);
    push({ where: 'restore', step: null, parentIdx: null, class: label(evidence), evidence: evidence.length ? evidence : [{ class: 'unknown', what: 'the restored world does not hash to the checkpoint and nothing accounts for it' }], paths: [] });
  }
  for (const s of steps) {
    if (s.denied || s.failed) {
      const evidence = [...externalEvidence(s, ctx), ...nondetEvidence(s)];
      push({ where: 'step', step: s.position, parentIdx: s.parentIdx, class: label(evidence), evidence: evidence.length ? evidence : [{ class: 'unknown', what: s.denied ? 'the replay was refused by the gate' : `the replayed command failed${s.error ? `: ${String(s.error).slice(0, 120)}` : ''}` }], paths: [] });
    } else if (s.paths.length) {
      const evidence = [...externalEvidence(s, ctx), ...nondetEvidence(s), ...driftEvidence(restore.drift, s.paths)];
      push({ where: 'step', step: s.position, parentIdx: s.parentIdx, class: label(evidence), evidence: evidence.length ? evidence : [{ class: 'unknown', what: 'the recorded and replayed results differ and nothing recorded explains it' }], paths: s.paths.slice(0, 20) });
    } else if (s.volatilePaths.length && allVolatile(s.volatilePaths, volatileKeys)) {
      push({ where: 'step', step: s.position, parentIdx: s.parentIdx, class: 'volatile', evidence: [{ class: 'volatile', what: `only declared volatile keys differ (${volatileKeys.join(', ')})` }], paths: s.volatilePaths.slice(0, 20) });
    } else if (s.volatilePaths.length) {
      // differs, but not inside a declared key: never called ok
      push({ where: 'step', step: s.position, parentIdx: s.parentIdx, class: 'unknown', evidence: [{ class: 'unknown', what: 'the raw results differ outside any declared volatile key' }], paths: s.volatilePaths.slice(0, 20) });
    }
  }
  if (final.missing) {
    push({ where: 'final', step: null, parentIdx: null, class: 'unknown', evidence: [{ class: 'unknown', what: 'one side has no final checkpoint, so the end states cannot be compared' }], paths: [] });
  } else if (final.paths.length) {
    const evidence = [...steps.flatMap((s) => [...externalEvidence(s, ctx), ...nondetEvidence(s)]), ...driftEvidence(restore.drift, final.paths)];
    push({ where: 'final', step: null, parentIdx: null, class: label(evidence), evidence: evidence.length ? evidence : [{ class: 'unknown', what: 'the final worlds differ and nothing recorded explains it' }], paths: final.paths.slice(0, 20) });
  } else if (final.volatilePaths.length) {
    push({ where: 'final', step: null, parentIdx: null, class: allVolatile(final.volatilePaths, volatileKeys) ? 'volatile' : 'unknown', evidence: [{ class: allVolatile(final.volatilePaths, volatileKeys) ? 'volatile' : 'unknown', what: allVolatile(final.volatilePaths, volatileKeys) ? `only declared volatile keys differ (${volatileKeys.join(', ')})` : 'the raw final worlds differ outside any declared volatile key' }], paths: final.volatilePaths.slice(0, 20) });
  }
  return out;
}

export const classCounts = (divergences) => Object.fromEntries(CLASSES.map((c) => [c, divergences.filter((d) => d.class === c).length]));
