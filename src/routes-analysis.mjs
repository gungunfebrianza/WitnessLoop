// HTTP routes for the analysis layer: causal graph, bisect, fork, replay-verify, compare, report.
import { buildCausal } from './causal.mjs';
import { bisect } from './bisect.mjs';
import { fork, replayVerify, compare } from './replay.mjs';
import { buildReport } from './report.mjs';
import { detectUnannotated } from './detect.mjs';
import { validatePolicy, evaluate, lintPolicy } from './policy.mjs';

export function installAnalysisRoutes({ route, api, HttpError }) {
  const need = (id) => {
    const s = api.ledger.getSession(id);
    if (!s) throw new HttpError(404, `no such session ${id}`);
    return s;
  };

  route('GET', '/sessions/:id/causal', ({ params }) => {
    need(params.id);
    return buildCausal(api.ledger.events(params.id, { hydrate: true }));
  });

  route('POST', '/sessions/:id/bisect', ({ params, body }) => {
    need(params.id);
    if (typeof api.profile.invariant !== 'function') throw new HttpError(400, 'the relay has no app profile with an invariant (start it with serve --profile <file>)');
    return bisect({ ledger: api.ledger, sessionId: Number(params.id), invariant: api.profile.invariant, search: body?.search ?? 'linear', volatileKeys: api.volatileKeys });
  });

  route('POST', '/sessions/:id/fork', ({ params, body }) => {
    need(params.id);
    return fork(api, {
      sessionId: Number(params.id), atIdx: body?.at, shadowAgent: body?.shadow, override: body?.override ?? {}, skip: body?.skip ?? [],
      policy: body?.policy ?? null, forceSame: !!body?.forceSame, autoApprove: body?.autoApprove !== false, actor: body?.actor ?? 'fork',
    });
  });

  route('POST', '/sessions/:id/replay-verify', ({ params, body }) => {
    need(params.id);
    return replayVerify(api, { sessionId: Number(params.id), shadowAgent: body?.shadow });
  });

  route('GET', '/compare', ({ query }) => {
    const a = Number(query.get('a'));
    const b = Number(query.get('b'));
    need(a); need(b);
    return compare(api, a, b);
  });

  const detect = (events) => detectUnannotated({ events, getBlob: (h) => api.ledger.getBlob(h), volatileKeys: api.volatileKeys });
  // What would this policy have decided for every irreversible intent already recorded? Read-only: nothing is appended, and
  // the context is built exactly as gate.mjs builds it, so an answer here is the answer the gate would have given.
  route('POST', '/sessions/:id/policy-dry-run', ({ params, body }) => {
    const session = need(params.id);
    let policy;
    try { policy = validatePolicy(body?.policy ?? api.getPolicy()); } catch (e) { throw new HttpError(400, `policy is not valid: ${e.message}`); }
    const events = api.ledger.events(params.id, { hydrate: true });
    const rows = events.filter((e) => e.kind === 'intent').map((i) => {
      const decisions = events.filter((e) => e.kind === 'decision' && e.data.intent_idx === i.idx);
      const first = decisions[0]?.data ?? null;
      const last = decisions.at(-1)?.data ?? null;
      const would = evaluate(policy, { type: i.type, effect: i.effect, params: i.data.params, preview: i.data.preview ?? null, target: i.data.describe?.label ?? null, agent: session.agent, actor: i.actor });
      return {
        intent_idx: i.idx, type: i.type, preview: i.data.preview ?? null,
        recorded: first ? { verdict: first.verdict, rule: first.rule, final: last.verdict, by: last.by ?? 'policy' } : null,
        would: { verdict: would.verdict, rule: would.rule, reason: would.reason, ...(would.limit ? { limit: true } : {}) },
        changed: !first || first.verdict !== would.verdict,
      };
    });
    return { session: Number(params.id), intents: rows.length, changed: rows.filter((r) => r.changed).length, rows, warnings: lintPolicy(policy), note: 'Compares the policy verdict only; a human decision that followed a require_approval is not re-asked. Nothing was recorded or run.' };
  });

  route('GET', '/sessions/:id/detections', ({ params }) => {
    need(params.id);
    return detect(api.ledger.events(params.id, { hydrate: true }));
  });

  route('GET', '/sessions/:id/report', ({ params }) => {
    const session = need(params.id);
    const events = api.ledger.events(params.id, { hydrate: true });
    return {
      markdown: buildReport({
        session, events, verify: api.ledger.verifySessionId(Number(params.id)), causal: buildCausal(events), detections: detect(events),
        children: api.ledger.listSessions().filter((s) => s.parent_session === Number(params.id)).map((s) => ({ id: s.id, goal: s.goal, status: s.status })),
      }),
    };
  });
}
