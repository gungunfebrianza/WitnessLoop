// Two-phase commit for irreversible effects: the proof precedes the consequence.
//   phase 1  append `intent` (what is about to happen, with the page's own preview of it)
//            append `decision` (policy verdict) and, if a human is needed, a second `decision`
//   phase 2  only if the last decision is `allow` does the caller dispatch the command
// Every ledger append happens BEFORE the command is dispatched and is not caught here, so if the
// ledger cannot record the intent or the decision the error propagates and nothing is dispatched
// (fail closed).
import crypto from 'node:crypto';
import { evaluate } from './policy.mjs';
import { approvalMessage, fingerprint, verifySignature } from './attest.mjs';

export class Approvals {
  // approvers: fingerprints of the keys allowed to release an irreversible action. allowUnsigned re-enables the old
  // self-declared `by` string and is off unless the operator asks for it.
  constructor({ timeoutMs = 300000, approvers = [], allowUnsigned = false } = {}) {
    this.timeoutMs = timeoutMs;
    this.approvers = new Set(approvers);
    this.allowUnsigned = allowUnsigned;
    this.pending = new Map();
    this.used = new Set(); // nonces already spent: a captured approval cannot be replayed
  }

  static id(sessionId, intentIdx) { return `${sessionId}.${intentIdx}`; }

  request(sessionId, intentIdx, info) {
    const id = Approvals.id(sessionId, intentIdx);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ allow: false, by: 'timeout', reason: 'approval_timeout' });
      }, this.timeoutMs);
      this.pending.set(id, { id, sessionId, intentIdx, info, nonce: crypto.randomBytes(16).toString('hex'), since: new Date().toISOString(), resolve, timer });
    });
  }

  // A denial that originates in the relay itself (shutdown), never from a person: needs no key, can only refuse.
  system(id, by, reason) {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve({ allow: false, by, reason });
    return true;
  }

  // A person's decision. It must be signed over {id, verdict, nonce} by a registered approver key; the nonce is
  // the one issued for THIS pending approval and is spent on use. Returns { ok } or { ok:false, status, error }
  // and leaves the approval pending on any failure, so a bad attempt never releases or refuses anything.
  decide(id, allow, { by = 'human', reason = null, approver_pub = null, sig = null, nonce = null } = {}) {
    const p = this.pending.get(id);
    if (!p) return nonce && this.used.has(nonce) ? { ok: false, status: 409, error: 'this approval was already used (replayed nonce)' } : { ok: false, status: 404, error: `no pending intent ${id}` };
    let approver = null;
    if (approver_pub != null || sig != null) {
      if (typeof approver_pub !== 'string' || typeof sig !== 'string') return { ok: false, status: 401, error: 'approval signature is incomplete' };
      const fp = fingerprint(approver_pub);
      if (!this.approvers.has(fp)) return { ok: false, status: 403, error: `approver key ${fp} is not registered with this relay` };
      if (this.used.has(nonce)) return { ok: false, status: 409, error: 'this approval was already used (replayed nonce)' };
      if (nonce !== p.nonce) return { ok: false, status: 401, error: 'nonce does not match this pending approval' };
      if (!verifySignature(approver_pub, approvalMessage({ id, verdict: allow ? 'allow' : 'deny', nonce: p.nonce }), sig)) return { ok: false, status: 401, error: 'approval signature is invalid' };
      approver = { fp, pub: approver_pub, sig, nonce: p.nonce };
    } else if (!this.allowUnsigned) {
      return { ok: false, status: 401, error: 'approvals must be signed by a registered approver key' };
    }
    clearTimeout(p.timer);
    this.pending.delete(id);
    this.used.add(p.nonce);
    p.resolve({ allow, by, reason, ...(approver ? { approver } : {}) });
    return { ok: true };
  }

  list() {
    return [...this.pending.values()].map(({ id, sessionId, intentIdx, info, since, nonce }) => ({ id, sessionId, intentIdx, since, nonce, ...info }));
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
    // a signed decision is attributed to the key, not to the self-declared label: `by` stays a label only
    kind: 'decision', actor: resolved.approver ? `approver:${resolved.approver.fp}` : resolved.by, type, effect, ok: resolved.allow,
    data: {
      intent_idx: intent.idx, resolves_idx: first.idx, verdict: resolved.allow ? 'allow' : 'deny', by: resolved.by, reason: resolved.reason,
      ...(resolved.approver ? { approver_fp: resolved.approver.fp, approver_pub: resolved.approver.pub, sig: resolved.approver.sig, nonce: resolved.approver.nonce } : {}),
    },
  });
  return { released: resolved.allow, intent, decision: second, reason: resolved.reason ?? verdict.reason, verdict: resolved.allow ? 'allow' : 'deny' };
}
