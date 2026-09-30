// A stand-in third-party API on its own loopback port: every call gets a different answer, so a replay that reaches it is visible.
import http from 'node:http';

export async function startProvider() {
  const calls = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', connection: 'close' });
    res.end(JSON.stringify({ n: ++n }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    origin: `http://127.0.0.1:${server.address().port}`, calls,
    close: () => new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }),
  };
}
