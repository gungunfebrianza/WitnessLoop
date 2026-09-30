// Tiny Shop: one page with an UNANNOTATED "Pay" button (the case the gate cannot see on its own).
// Run standalone: node examples/shop/server.mjs [port]   then open  http://127.0.0.1:<port>/?witness=1
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAppServer, sendJson, readJson } from '../lib/server.mjs';
import { initialState, pay } from './model.mjs';

export async function startShop({ port = 0 } = {}) {
  const box = { state: initialState() };
  const app = await startAppServer({
    publicDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'public'), port,
    adapter: { getState: () => box.state, setState: (s) => { box.state = s; } },
    api: async (req, res, url) => {
      if (url.pathname === '/api/state' && req.method === 'GET') { sendJson(res, 200, box.state); return true; }
      if (url.pathname === '/api/pay' && req.method === 'POST') {
        const r = pay(box.state, await readJson(req));
        sendJson(res, r.ok ? 200 : 400, r);
        return true;
      }
      return false;
    },
  });
  return { ...app, box };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await startShop({ port: Number(process.argv[2]) || 3104 });
  console.log(`Tiny Shop on ${app.origin}/?witness=1`);
}
