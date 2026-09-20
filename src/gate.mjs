// Two-phase commit for irreversible effects: the proof precedes the consequence.
//   phase 1  append `intent` (what is about to happen, with the page's own preview of it)
//            append `decision` (policy verdict) and, if a human is needed, a second `decision`
//   phase 2  only if the last decision is `allow` does the caller dispatch the command
// Every ledger append happens BEFORE the command is dispatched and is not caught here, so if the
// ledger cannot record the intent or the decision the error propagates and nothing is dispatched
// (fail closed).
import { evaluate } from './policy.mjs';

export class Approvals {
  constructor({ timeoutMs = 300000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
  }

  static id(sessionId, intentIdx) { return `${sessionId}.${intentIdx}`; }

  request(sessionId, intentIdx, info) {
    const id = Approvals.id(sessionId, intentIdx);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ allow: false, by: 'timeout', reason: 'approval_timeout' });
      }, this.timeoutMs);
      this.pending.set(id, { id, sessionId, intentIdx, info, since: new Date().toISOString(), resolve, timer });
    });
  }

  resolve(id, allow, by = 'human', reason = null) {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve({ allow, by, reason });
    return true;
  }

  list() {
    return [...this.pending.values()].map(({ id, sessionId, intentIdx, info, since }) => ({ id, sessionId, intentIdx, since, ...info }));
  }
}

export async function gate({ ledger, approvals, policy, sessionId, actor, type, effect, params, describe, agent, autoApprove = false }) {
  const preview = describe?.preview ?? null;
  const intent = ledger.append(sessionId, { kind: 'intent', actor, type, effect, data: { params, describe, preview } });
  const ctx = { type, effect, params, preview, target: describe?.label ?? null, agent, actor };
  const verdict = evaluate(policy, ctx);
  const first = ledger.append(sessionId, {
    kind: 'decision', actor: 'policy', type, effect, ok: verdict.verdict === 'allow',
    data: { intent_idx: intent.idx, verdict: verdict.verdict, rule: verdict.rule, reason: verdict.reason },
  });
  if (verdict.verdict === 'allow') return { released: true, intent, decision: first, reason: verdict.reason };
  if (verdict.verdict === 'deny') return { released: false, intent, decision: first, reason: verdict.reason, verdict: 'deny' };

  let resolved;
  if (autoApprove) resolved = { allow: true, by: 'auto-approve', reason: 'shadow environment' };
  else resolved = await approvals.request(sessionId, intent.idx, { type, effect, preview, params, target: ctx.target, policyReason: verdict.reason });
  const second = ledger.append(sessionId, {
    kind: 'decision', actor: resolved.by, type, effect, ok: resolved.allow,
    data: { intent_idx: intent.idx, resolves_idx: first.idx, verdict: resolved.allow ? 'allow' : 'deny', by: resolved.by, reason: resolved.reason },
  });
  return { released: resolved.allow, intent, decision: second, reason: resolved.reason ?? verdict.reason, verdict: resolved.allow ? 'allow' : 'deny' };
}
