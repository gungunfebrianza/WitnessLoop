// What a page drew from Date.now / Math.random during one command. Recorded from a production session (opt-in) and fed back to a
// shadow copy. The page is untrusted, so anything read back from a ledger is cleaned again before it is used: numbers only, bounded.
export const ND_CAP = 500;

export function cleanNondet(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const nums = (a) => (Array.isArray(a) ? a.slice(0, ND_CAP).filter((v) => typeof v === 'number' && Number.isFinite(v)) : []);
  const now = nums(x.now);
  const random = nums(x.random);
  return now.length || random.length ? { now, random, ...(x.truncated ? { truncated: true } : {}) } : null;
}
