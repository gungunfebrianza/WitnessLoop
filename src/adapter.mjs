// What an app mounts so witnessloop can checkpoint and restore its SERVER-side state.
//   GET  /__witness/state    -> JSON state
//   POST /__witness/restore  -> replace state with the posted JSON
// Call handleWitnessRequest first in the app's request handler; it returns true when it answered.
export function handleWitnessRequest(req, res, { getState, setState }) {
  const url = (req.url ?? '').split('?')[0];
  if (url === '/__witness/state' && req.method === 'GET') {
    const text = JSON.stringify(getState());
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(text);
    return true;
  }
  if (url === '/__witness/restore' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        setState(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      } catch (e) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return true;
  }
  return false;
}
