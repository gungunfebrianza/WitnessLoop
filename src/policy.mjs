// Declarative gate policy. First matching rule wins; `default` covers everything else.
//   { "default": "require_approval",
//     "rules": [ { "when": { "preview.amount": { "lte": 100 }, "preview.to": { "in": ["alice","bob"] } },
//                  "then": "allow", "reason": "small transfer to a known payee" },
//                { "when": { "preview.amount": { "gt": 1000 } }, "then": "deny" } ] }
// `when` keys are paths into { type, effect, params, preview, target, agent, actor }; every key must match.
// A condition is a bare value (equality) or an object of operators:
//   eq ne lt lte gt gte in nin matches exists
import vm from 'node:vm';
import { getPath, canon } from './canon.mjs';

export const VERDICTS = ['allow', 'deny', 'require_approval'];
export const DEFAULT_POLICY = { default: 'require_approval', rules: [] };

// `matches` is evaluated in a throwaway vm context under a time limit: JavaScript regexes backtrack, and a pattern like
// (a+)+$ against a long input can hold the relay for minutes. A policy the relay cannot evaluate safely must not become a
// silent "no match" (that would turn a deny rule into nothing), so a limit hit falls back to a stricter verdict, see evaluate().
// A wall-clock cap cannot tell "the pattern is catastrophic" from "this process was descheduled": a busy machine could
// turn a harmless pattern into a limit hit. So a first timeout is retried once with a longer allowance; a real blowup
// costs both, a stall rarely hits twice.
export const LIMITS = { regexSource: 200, regexInput: 2000, regexMs: 250, regexRetryMs: 1000 };
export class PolicyLimit extends Error {}
const RUN_REGEX = new vm.Script('new RegExp(p).test(s)');
const REGEX_CTX = vm.createContext({ p: '', s: '' }); // one context, reused: creating one per call is the slow part
function regexTest(pattern, input) {
  const p = String(pattern);
  const s = String(input);
  if (p.length > LIMITS.regexSource) throw new PolicyLimit(`pattern is ${p.length} characters (limit ${LIMITS.regexSource})`);
  if (s.length > LIMITS.regexInput) throw new PolicyLimit(`input is ${s.length} characters (limit ${LIMITS.regexInput})`);
  REGEX_CTX.p = p;
  REGEX_CTX.s = s;
  for (const ms of [LIMITS.regexMs, LIMITS.regexRetryMs]) {
    try { return RUN_REGEX.runInContext(REGEX_CTX, { timeout: ms }); } catch (e) {
      if (e?.code !== 'ERR_SCRIPT_EXECUTION_TIMEOUT') throw e;
    }
  }
  throw new PolicyLimit(`pattern did not finish within ${LIMITS.regexRetryMs}ms`);
}

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
    case 'matches': return got !== undefined && got !== null && regexTest(want, got);
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
        for (const [op, want] of Object.entries(cond)) {
          testOp(op, 0, 0);
          if (op === 'matches') {
            if (typeof want !== 'string') throw new Error(`rule ${i}: matches needs a string pattern`);
            if (want.length > LIMITS.regexSource) throw new Error(`rule ${i}: matches pattern is ${want.length} characters (limit ${LIMITS.regexSource})`);
            try { new RegExp(want); } catch (e) { throw new Error(`rule ${i}: matches pattern does not compile: ${e.message}`); }
          }
        }
      }
    }
  }
  return policy;
}

export function evaluate(policy, ctx) {
  const p = policy ?? DEFAULT_POLICY;
  for (const [i, rule] of (p.rules ?? []).entries()) {
    const when = rule.when ?? {};
    let hit;
    try { hit = Object.entries(when).every(([path, cond]) => matches(cond, getPath(ctx, path))); } catch (e) {
      if (!(e instanceof PolicyLimit)) throw e;
      // cannot tell whether this rule applies: never guess it away. A human decides, unless the policy's own default is to refuse.
      return { verdict: p.default === 'deny' ? 'deny' : 'require_approval', rule: i, reason: `regex limit exceeded in rule ${i}: ${e.message}`, limit: true };
    }
    if (hit) return { verdict: rule.then, rule: i, reason: rule.reason ?? `rule ${i}` };
  }
  return { verdict: p.default ?? 'require_approval', rule: null, reason: 'policy default' };
}

// ---------------------------------------------------------------- lint
// Does every context that satisfies condition J also satisfy condition I? Only ever answers true when it is provable from
// the two conditions alone; anything unclear is false, so a shadowing warning is never a guess.
const asOps = (c) => (c !== null && typeof c === 'object' && !Array.isArray(c) ? Object.entries(c) : [['eq', c]]);
const holds = (op, want, got) => { try { return testOp(op, want, got); } catch { return false; } };
function opImplies(opJ, wJ, opI, wI) {
  if (opJ === opI && canon(wJ) === canon(wI)) return true;
  if (opJ === 'eq') return holds(opI, wI, wJ);
  if (opJ === 'in' && Array.isArray(wJ) && wJ.length) return wJ.every((v) => holds(opI, wI, v));
  const a = num(wJ);
  const b = num(wI);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  const upper = { lt: 0, lte: 1 };
  const lower = { gt: 0, gte: 1 };
  if (opJ in upper && opI in upper) return opI === 'lte' ? a <= b : opJ === 'lt' ? a <= b : a < b;
  if (opJ in lower && opI in lower) return opI === 'gte' ? a >= b : opJ === 'gt' ? a >= b : a > b;
  return false;
}
const condImplies = (cJ, cI) => asOps(cI).every(([opI, wI]) => asOps(cJ).some(([opJ, wJ]) => opImplies(opJ, wJ, opI, wI)));
// rule I covers rule J when I's every constraint is already implied by J's constraint on the same path
const covers = (I, J) => Object.entries(I.when ?? {}).every(([path, cI]) => path in (J.when ?? {}) && condImplies(J.when[path], cI));

// Heuristics for a regex that backtracks badly. Warnings only: the runtime cap (LIMITS) is what actually protects the relay.
export function regexRisk(src) {
  const s = String(src);
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\})/.test(s)) return 'a quantified group that itself contains an unbounded quantifier, e.g. (a+)+';
  if (/\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)\s*(?:[+*]|\{\d+,\})/.test(s)) return 'an alternation under an unbounded quantifier, e.g. (a|a)*';
  if (/(?:\.\*|\.\+).*(?:\.\*|\.\+)/.test(s)) return 'two unbounded wildcards, which can backtrack quadratically';
  return null;
}

export function lintPolicy(policy) {
  const rules = policy?.rules ?? [];
  const out = [];
  rules.forEach((rule, j) => {
    const i = rules.findIndex((r, k) => k < j && covers(r, rule));
    if (i >= 0) {
      const differs = rules[i].then !== rule.then;
      out.push({ kind: 'shadowed', rule: j, by: i, decidesDifferently: differs, message: `rule ${j} can never match: rule ${i} already matches everything it does${differs ? ` and decides differently (${rules[i].then}, not ${rule.then})` : ''}` });
    }
    for (const [path, cond] of Object.entries(rule.when ?? {})) {
      const m = asOps(cond).find(([op]) => op === 'matches');
      const risk = m && typeof m[1] === 'string' ? regexRisk(m[1]) : null;
      if (risk) out.push({ kind: 'regex', rule: j, path, message: `rule ${j}: matches on ${path} looks prone to catastrophic backtracking (${risk}); the relay stops it after ${LIMITS.regexRetryMs}ms and asks a human, but rewrite it` });
    }
  });
  return out;
}
