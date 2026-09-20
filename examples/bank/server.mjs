// Tiny Bank: a page where alice pays people. The transfer button is an IRREVERSIBLE effect.
// Run standalone: node examples/bank/server.mjs [port]   then open  http://127.0.0.1:<port>/?witness=1
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAppServer, sendJson, readJson } from '../lib/server.mjs';
import { initialState, transfer } from './model.mjs';

export async function startBank({ port = 0 } = {}) {
  const box = { state: initialState() };
  const app = await startAppServer({
    publicDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'public'), port,
    adapter: { getState: () => box.state, setState: (s) => { box.state = s; } },
    api: async (req, res, url) => {
      if (url.pathname === '/api/state' && req.method === 'GET') { sendJson(res, 200, box.state); return true; }
      if (url.pathname === '/api/transfer' && req.method === 'POST') {
        const r = transfer(box.state, { from: 'alice', ...(await readJson(req)) });
        sendJson(res, r.ok ? 200 : 400, r);
        return true;
      }
      return false;
    },
  });
  return { ...app, box };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await startBank({ port: Number(process.argv[2]) || 3101 });
  console.log(`Tiny Bank on ${app.origin}/?witness=1`);
}
