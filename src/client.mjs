// Thin fetch wrapper over the relay's HTTP API. Used by the CLI, the MCP server, the example
// agents and the tests, so they all see the same envelope: { ok, result } | { ok:false, error }.
export const DEFAULT_PORT = 8974;

import { approvalMessage, signMessage } from './attest.mjs';
import { resolveToken } from './auth.mjs';

export function createClient({ port = Number(process.env.WITNESSLOOP_PORT) || DEFAULT_PORT, host = '127.0.0.1', approverKey = null, token } = {}) {
  const base = `http://${host}:${port}`;
  // token: explicit, else WITNESSLOOP_TOKEN, else .witnessloop/token. None found means requests go out bare and the relay answers 401.
  const bearer = resolveToken({ token });

  async function request(method, path, body) {
    let res;
    try {
      const headers = { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) };
      res = await fetch(base + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch (e) {
      const err = new Error(`cannot reach the witnessloop relay at ${base} (${e.cause?.code ?? e.message}). Start it with: witnessloop serve`);
      err.status = 0;
      throw err;
    }
    const json = await res.json();
    if (!json.ok) {
      const err = new Error(json.error ?? `HTTP ${res.status}`);
      err.status = res.status;
      err.extra = json.extra;
      throw err;
    }
    return json.result;
  }

  // With an approver key the decision is signed over {id, verdict, nonce} using the nonce the relay issued for this
  // pending approval; without one it goes out unsigned and the relay refuses it unless it allows unsigned approvals.
  async function decide(verb, id, body, key) {
    if (!key) return request('POST', `/gate/${id}/${verb}`, body);
    const p = (await request('GET', '/gate/pending')).find((x) => x.id === id);
    if (!p) { const err = new Error(`no pending intent ${id}`); err.status = 404; throw err; }
    const sig = signMessage(key.privateKey, approvalMessage({ id, verdict: verb === 'approve' ? 'allow' : 'deny', nonce: p.nonce }));
    return request('POST', `/gate/${id}/${verb}`, { ...body, approver_pub: key.publicKey, sig, nonce: p.nonce });
  }

  return {
    base, request,
    health: () => request('GET', '/health'),
    agents: () => request('GET', '/agents'),
    getPolicy: () => request('GET', '/policy'),
    setPolicy: (p) => request('PUT', '/policy', p),
    startSession: (o = {}) => request('POST', '/sessions', o).then((r) => r.id),
    endSession: (id, summary) => request('POST', `/sessions/${id}/end`, { summary }),
    sessions: () => request('GET', '/sessions'),
    events: (id, hydrate = true) => request('GET', `/sessions/${id}/events?hydrate=${hydrate ? 1 : 0}`),
    cmd: (type, params = {}, { agent = 'default', actor = 'agent', sessionId } = {}) => request('POST', '/command', { type, params, agent, actor, sessionId }),
    pending: () => request('GET', '/gate/pending'),
    approve: (id, body = {}, { key = approverKey } = {}) => decide('approve', id, body, key),
    deny: (id, body = {}, { key = approverKey } = {}) => decide('deny', id, body, key),
    checkpoint: (agent = 'default', label = 'manual') => request('POST', '/checkpoint', { agent, label }),
    // opts beyond strict (anchors, pinned keys) travel in a POST body so the relay still runs the full check, fork anchor included
    verify: (id, o = false) => {
      const opts = typeof o === 'object' ? o : { strict: o };
      const extra = Object.keys(opts).some((k) => k !== 'strict' && opts[k] != null);
      return extra ? request('POST', `/sessions/${id}/verify`, opts) : request('GET', `/sessions/${id}/verify?strict=${opts.strict ? 1 : 0}`);
    },
    rotateKey: () => request('POST', '/key/rotate', {}),
    revokeKey: (fp) => request('POST', '/key/revoke', { fingerprint: fp }),
    anchor: (id) => request('POST', `/sessions/${id}/anchor`, {}),
    bundle: (id) => request('GET', `/sessions/${id}/bundle`),
    causal: (id) => request('GET', `/sessions/${id}/causal`),
    bisect: (id, opts = {}) => request('POST', `/sessions/${id}/bisect`, opts),
    fork: (id, opts = {}) => request('POST', `/sessions/${id}/fork`, opts),
    replayVerify: (id, opts = {}) => request('POST', `/sessions/${id}/replay-verify`, opts),
    compare: (a, b) => request('GET', `/compare?a=${a}&b=${b}`),
    report: (id) => request('GET', `/sessions/${id}/report`),
    policyDryRun: (id, policy) => request('POST', `/sessions/${id}/policy-dry-run`, policy === undefined ? {} : { policy }),
    detect: (id) => request('GET', `/sessions/${id}/detections`),
  };
}
