// Reusable effect checks, so an app profile states WHAT must hold instead of hand-writing the comparison.
// Every builder returns a check: (ctx) => { ok: true } | { ok: false, why, evidence? }. For a profile's `invariant`
// ctx is the world; for its `effectCheck` ctx is { type, params, preview, result, before, after }.
// Fail closed: a check that cannot compute its answer (a throw, a value that is not a finite number) is a failure with
// a reason, never a pass. The caller supplies the wording, so an app keeps its own messages.
const OK = { ok: true };
const fail = (why, evidence) => ({ ok: false, why, ...(evidence !== undefined ? { evidence } : {}) });
const finite = (v) => typeof v === 'number' && Number.isFinite(v);

// Wrap a check body so an error inside it can never read as success.
const guarded = (body) => (ctx) => {
  try { return body(ctx); } catch (e) { return fail(`check could not run: ${e.message}`); }
};

// A numeric total equals what it must. why({ total, expected }, ctx).
export const conserved = ({ total, expected, why }) => guarded((ctx) => {
  const t = total(ctx);
  const want = typeof expected === 'function' ? expected(ctx) : expected;
  return finite(t) && finite(want) && t === want ? OK : fail(why({ total: t, expected: want }, ctx));
});

// A number moved by exactly what the preview promised: read(after) - read(before) === promised(ctx).
// why({ moved, promised }, ctx). NaN on either side is a failure, so a missing account or an unparsable amount cannot pass.
export const deltaEquals = ({ read, promised, why }) => guarded((ctx) => {
  const moved = read(ctx.after, ctx) - read(ctx.before, ctx);
  const want = promised(ctx);
  return finite(moved) && finite(want) && moved === want ? OK : fail(why({ moved, promised: want }, ctx));
});

// Every member of `actual` was shown in advance (a subset of `allowed`). why({ extra }, ctx). Nothing delivered is a pass:
// this check only catches what was not promised, use sameMembers to also require what was.
export const noExtraMembers = ({ actual, allowed, why, evidence }) => guarded((ctx) => {
  const ok = new Set(allowed(ctx).map(String));
  const extra = actual(ctx).filter((m) => !ok.has(String(m)));
  return extra.length ? fail(why({ extra }, ctx), evidence ? evidence(ctx) : undefined) : OK;
});

// The set that happened equals the set that was promised, both ways. why({ extra, missing }, ctx).
export const sameMembers = ({ actual, expected, why, evidence }) => guarded((ctx) => {
  const got = new Set(actual(ctx).map(String));
  const want = new Set(expected(ctx).map(String));
  const extra = [...got].filter((m) => !want.has(m));
  const missing = [...want].filter((m) => !got.has(m));
  return extra.length || missing.length ? fail(why({ extra, missing }, ctx), evidence ? evidence(ctx) : undefined) : OK;
});

// An object carries no fields beyond those the preview named. why({ extra }, ctx).
export const noExtraFields = ({ actual, allowed, why }) => guarded((ctx) => {
  const obj = actual(ctx);
  if (obj === null || typeof obj !== 'object') return fail('nothing to compare: the recorded object is missing');
  const ok = new Set(allowed(ctx));
  const extra = Object.keys(obj).filter((k) => !ok.has(k));
  return extra.length ? fail(why({ extra }, ctx)) : OK;
});

// Nothing in the world matches `find` (returns the offender, or null). why(offender, ctx).
export const forbid = ({ find, why }) => guarded((ctx) => {
  const bad = find(ctx);
  return bad ? fail(why(bad, ctx)) : OK;
});

// Checks run in order; the first failure is the answer, so put the cheapest or most specific first.
export const allOf = (...checks) => guarded((ctx) => {
  for (const c of checks) { const r = c(ctx); if (!r || r.ok !== true) return r && r.ok === false ? r : fail('a check returned no verdict'); }
  return OK;
});
