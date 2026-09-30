// Third-party HTTP responses, recorded from a production session and served back to a shadow replay so it never touches the network.
// Off unless the operator names origins. The page is untrusted: entries for any other origin are dropped, fields are clipped, sizes are capped.
export const EXTERNAL_NOTE = 'replayed against recorded external responses';
export const EXT_BODY_CAP = 256 * 1024; // bytes per response; a bigger one is not recorded, and so cannot be replayed
export const EXT_MAX_CALLS = 50; // per command

export function validateOrigins(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) throw new Error('externalOrigins must be an array of origins like https://api.example.com');
  return list.map((s) => {
    let u;
    try { u = new URL(String(s)); } catch { throw new Error(`externalOrigins: "${s}" is not a URL`); }
    if (!/^https?:$/.test(u.protocol) || u.origin !== String(s).replace(/\/$/, '')) throw new Error(`externalOrigins: "${s}" must be a bare http(s) origin such as ${u.origin}`);
    return u.origin;
  });
}

const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
const hex = (v) => (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v) ? v : null);

// What the page's recorder reported, reduced to the fields we store. Anything for an origin the operator did not name is dropped.
export function cleanExternal(list, origins) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const x of list.slice(0, EXT_MAX_CALLS)) {
    if (!x || typeof x !== 'object' || !origins.includes(x.origin)) continue;
    const status = Number.isInteger(x.status) && x.status >= 100 && x.status <= 599 ? x.status : null;
    const body = typeof x.body_b64 === 'string' && !x.truncated && x.body_b64.length <= Math.ceil(EXT_BODY_CAP / 3) * 4 + 4 ? x.body_b64 : null;
    out.push({
      method: (clip(x.method, 16) ?? 'GET').toUpperCase(), origin: x.origin, path: clip(x.path, 400) ?? '', query_hash: hex(x.query_hash), req_hash: hex(x.req_hash),
      status, content_type: clip(x.content_type, 200), bytes: Number.isInteger(x.bytes) && x.bytes >= 0 ? x.bytes : null,
      ...(body === null || status === null ? { truncated: true } : {}), body_b64: body === null || status === null ? null : body,
    });
  }
  return out;
}
