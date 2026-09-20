// Thin fetch wrapper over the relay's HTTP API. Used by the CLI, the MCP server, the example
// agents and the tests, so they all see the same envelope: { ok, result } | { ok:false, error }.
export const DEFAULT_PORT = 8974;

export function createClient({ port = Number(process.env.WITNESSLOOP_PORT) || DEFAULT_PORT, host = '127.0.0.1' } = {}) {
  const base = `http://${host}:${port}`;

  async function request(method, path, body) {
    let res;
    try {
      res = await fetch(base + path, { method, headers: body !== undefined ? { 'content-type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
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
    approve: (id, body = {}) => request('POST', `/gate/${id}/approve`, body),
    deny: (id, body = {}) => request('POST', `/gate/${id}/deny`, body),
    checkpoint: (agent = 'default', label = 'manual') => request('POST', '/checkpoint', { agent, label }),
    verify: (id, strict = false) => request('GET', `/sessions/${id}/verify?strict=${strict ? 1 : 0}`),
    bundle: (id) => request('GET', `/sessions/${id}/bundle`),
    causal: (id) => request('GET', `/sessions/${id}/causal`),
    bisect: (id, opts = {}) => request('POST', `/sessions/${id}/bisect`, opts),
    fork: (id, opts = {}) => request('POST', `/sessions/${id}/fork`, opts),
    replayVerify: (id, opts = {}) => request('POST', `/sessions/${id}/replay-verify`, opts),
    compare: (a, b) => request('GET', `/compare?a=${a}&b=${b}`),
    report: (id) => request('GET', `/sessions/${id}/report`),
  };
}
