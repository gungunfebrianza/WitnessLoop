// Tiny static + JSON-API server the example apps share. It serves the in-page agent at
// /witnessloop/inject.js and mounts the witness adapter for server-side state.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleWitnessRequest } from '../../src/adapter.mjs';

const INJECT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'agent', 'inject.js');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

export const sendJson = (res, status, obj) => {
  const text = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(text);
};

export async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(buf);
  });
}

export async function startAppServer({ publicDir, port = 0, api = async () => false, adapter = null }) {
  const root = path.resolve(publicDir);
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (adapter && handleWitnessRequest(req, res, adapter)) return;
      if (url.pathname === '/witnessloop/inject.js') return sendFile(res, INJECT);
      if (await api(req, res, url)) return;
      const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      const file = path.resolve(root, rel);
      if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      sendFile(res, file);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: e.message });
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const actual = server.address().port;
  return {
    server, port: actual, origin: `http://127.0.0.1:${actual}`,
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
  };
}
