// HTTP routes for the analysis layer: causal graph, bisect, fork, replay-verify, compare, report.
import { buildCausal } from './causal.mjs';
import { bisect } from './bisect.mjs';
import { fork, replayVerify, compare } from './replay.mjs';
import { buildReport } from './report.mjs';

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

  route('GET', '/sessions/:id/report', ({ params }) => {
    const session = need(params.id);
    const events = api.ledger.events(params.id, { hydrate: true });
    return {
      markdown: buildReport({
        session, events, verify: api.ledger.verifySessionId(Number(params.id)), causal: buildCausal(events),
        children: api.ledger.listSessions().filter((s) => s.parent_session === Number(params.id)).map((s) => ({ id: s.id, goal: s.goal, status: s.status })),
      }),
    };
  });
}
