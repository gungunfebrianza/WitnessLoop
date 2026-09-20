// Declarative gate policy. First matching rule wins; `default` covers everything else.
//   { "default": "require_approval",
//     "rules": [ { "when": { "preview.amount": { "lte": 100 }, "preview.to": { "in": ["alice","bob"] } },
//                  "then": "allow", "reason": "small transfer to a known payee" },
//                { "when": { "preview.amount": { "gt": 1000 } }, "then": "deny" } ] }
// `when` keys are paths into { type, effect, params, preview, target, agent, actor }; every key must match.
// A condition is a bare value (equality) or an object of operators:
//   eq ne lt lte gt gte in nin matches exists
import { getPath, canon } from './canon.mjs';

export const VERDICTS = ['allow', 'deny', 'require_approval'];
export const DEFAULT_POLICY = { default: 'require_approval', rules: [] };

const num = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);

function testOp(op, want, got) {
  switch (op) {
    case 'eq': return canon(got) === canon(want) || String(got) === String(want);
    case 'ne': return !testOp('eq', want, got);
    case 'lt': return num(got) < num(want);
    case 'lte': return num(got) <= num(want);
    case 'gt': return num(got) > num(want);
    case 'gte': return num(got) >= num(want);
    case 'in': return Array.isArray(want) && want.some((w) => String(w) === String(got));
    case 'nin': return Array.isArray(want) && !want.some((w) => String(w) === String(got));
    case 'matches': return got !== undefined && got !== null && new RegExp(want).test(String(got));
    case 'exists': return want ? got !== undefined && got !== null : got === undefined || got === null;
    default: throw new Error(`unknown policy operator "${op}"`);
  }
}

export function matches(cond, got) {
  if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
    return Object.entries(cond).every(([op, want]) => testOp(op, want, got));
  }
  return testOp('eq', cond, got);
}

export function validatePolicy(policy) {
  if (!policy || typeof policy !== 'object') throw new Error('policy must be an object');
  if (policy.default !== undefined && !VERDICTS.includes(policy.default)) throw new Error(`policy.default must be one of ${VERDICTS.join(', ')}`);
  for (const [i, r] of (policy.rules ?? []).entries()) {
    if (!VERDICTS.includes(r.then)) throw new Error(`rule ${i}: "then" must be one of ${VERDICTS.join(', ')}`);
    for (const cond of Object.values(r.when ?? {})) {
      if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
        for (const op of Object.keys(cond)) testOp(op, 0, 0);
      }
    }
  }
  return policy;
}

export function evaluate(policy, ctx) {
  const p = policy ?? DEFAULT_POLICY;
  for (const [i, rule] of (p.rules ?? []).entries()) {
    const when = rule.when ?? {};
    if (Object.entries(when).every(([path, cond]) => matches(cond, getPath(ctx, path)))) {
      return { verdict: rule.then, rule: i, reason: rule.reason ?? `rule ${i}` };
    }
  }
  return { verdict: p.default ?? 'require_approval', rule: null, reason: 'policy default' };
}
