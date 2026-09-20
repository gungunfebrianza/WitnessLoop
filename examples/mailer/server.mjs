// Outbox mailer: search contacts, compose, Send (IRREVERSIBLE).
// Run standalone: node examples/mailer/server.mjs [port]   then open  http://127.0.0.1:<port>/?witness=1
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAppServer, sendJson, readJson } from '../lib/server.mjs';
import { initialState, send } from './model.mjs';

export async function startMailer({ port = 0 } = {}) {
  const box = { state: initialState() };
  const app = await startAppServer({
    publicDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'public'), port,
    adapter: { getState: () => box.state, setState: (s) => { box.state = s; } },
    api: async (req, res, url) => {
      if (url.pathname === '/api/state' && req.method === 'GET') { sendJson(res, 200, box.state); return true; }
      if (url.pathname === '/api/send' && req.method === 'POST') {
        const r = send(box.state, await readJson(req));
        sendJson(res, r.ok ? 200 : 400, r);
        return true;
      }
      return false;
    },
  });
  return { ...app, box };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await startMailer({ port: Number(process.argv[2]) || 3102 });
  console.log(`Outbox mailer on ${app.origin}/?witness=1`);
}
