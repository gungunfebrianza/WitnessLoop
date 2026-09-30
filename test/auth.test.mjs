import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRelay } from '../src/relay.mjs';
import { createClient } from '../src/client.mjs';
import { newToken, tokenMatches, bearerOf, writeTokenFile, resolveToken } from '../src/auth.mjs';
import { withBank, transferVia, waitFor } from './helpers/relay.mjs';

// async: the relay runs in this process, so a blocking spawn would starve it
const run = (args, env) => promisify(execFile)(process.execPath, [CLI, ...args], { env, encoding: 'utf8' }).then((r) => ({ status: 0, ...r }), (e) => ({ status: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }));
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');
const url = (relay, p) => `http://127.0.0.1:${relay.port}${p}`;
const call = (relay, method, p, { token, body } = {}) => fetch(url(relay, p), {
  method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: body !== undefined ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

test('every route refuses a missing or wrong token with 401, including the ones that approve, change policy and run commands', async () => {
  await withBank(async ({ relay, client }) => {
    const sid = await client.startSession({});
    const routes = [
      ['GET', '/health'], ['GET', '/agents'], ['GET', '/policy'], ['PUT', '/policy', { default: 'allow', rules: [] }],
      ['POST', '/sessions', {}], ['GET', '/sessions'], ['POST', `/sessions/${sid}/end`, {}], ['GET', `/sessions/${sid}/events`],
      ['POST', '/command', { type: 'dom.click', params: { selector: '#send' } }], ['GET', '/gate/pending'],
      ['POST', '/gate/1.1/approve', {}], ['POST', '/gate/1.1/deny', {}], ['POST', '/checkpoint', {}],
      ['GET', `/sessions/${sid}/verify`], ['POST', `/sessions/${sid}/verify`, {}], ['GET', `/sessions/${sid}/bundle`],
      ['POST', `/sessions/${sid}/anchor`, {}], ['POST', '/key/rotate', {}], ['POST', '/key/revoke', { fingerprint: '0'.repeat(16) }],
      ['GET', `/sessions/${sid}/causal`], ['POST', `/sessions/${sid}/bisect`, {}], ['POST', `/sessions/${sid}/fork`, {}],
      ['GET', `/sessions/${sid}/report`], ['GET', '/dashboard/overview'], ['GET', `/dashboard/sessions/${sid}`],
      ['POST', `/dashboard/sessions/${sid}/tamper`, { mode: 'payload' }], ['POST', `/dashboard/sessions/${sid}/whatif`, { policy: { default: 'allow' } }],
    ];
    for (const [method, p, body] of routes) {
      for (const token of [undefined, 'wrong', relay.token.slice(0, -1), relay.token + 'x']) {
        const r = await call(relay, method, p, { token, body });
        assert.equal(r.status, 401, `${method} ${p} with ${token === undefined ? 'no token' : 'a bad token'}`);
        assert.equal(r.json.ok, false);
      }
    }
    // a non-Bearer scheme is not accepted either
    const basic = await fetch(url(relay, '/health'), { headers: { authorization: `Basic ${relay.token}` } });
    assert.equal(basic.status, 401);
    // and none of the refused calls had any effect
    assert.deepEqual((await client.getPolicy()).default, 'require_approval');
    assert.equal((await client.sessions()).length, 1);
    assert.equal((await client.events(sid)).filter((e) => e.kind === 'command').length, 0);
    // the right token works
    assert.equal((await call(relay, 'GET', '/health', { token: relay.token })).status, 200);
  });
});

test('a caller without the token cannot approve a held action, and the held action is untouched', async () => {
  await withBank(async ({ relay, client, bank }) => {
    await client.startSession({});
    const inflight = transferVia(client, 'bob', 300).catch((e) => e);
    const [p] = await waitFor(async () => { const l = await client.pending(); return l.length ? l : null; });
    assert.equal((await call(relay, 'POST', `/gate/${p.id}/approve`, { body: { by: 'attacker' } })).status, 401);
    assert.equal((await call(relay, 'POST', `/gate/${p.id}/approve`, { token: 'guess', body: { by: 'attacker' } })).status, 401);
    assert.equal((await client.pending()).length, 1);
    assert.ok(!bank.agent.seen.some((m) => m.type === 'dom.click'));
    await client.deny(p.id, {});
    await inflight;
  }, { policy: { default: 'require_approval', rules: [] } });
});

test('the WebSocket agent link needs the token: no token or a wrong one never registers an agent, and cannot displace a connected one', async () => {
  await withBank(async ({ relay, bank, client }) => {
    const connect = (token) => new Promise((resolve) => {
      const q = token === undefined ? '' : `&token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/agent?name=default&loadId=evil${q}`);
      ws.onopen = () => resolve({ opened: true, ws });
      ws.onerror = () => resolve({ opened: false });
    });
    for (const t of [undefined, '', 'wrong', relay.token.slice(1)]) {
      const r = await connect(t);
      assert.equal(r.opened, false, `token ${JSON.stringify(t)} must not open the link`);
    }
    // raw handshake: the relay answers 401 rather than upgrading
    const status = await new Promise((resolve, reject) => {
      const s = net.connect(relay.port, '127.0.0.1', () => s.write('GET /agent?name=default HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'));
      let buf = '';
      s.on('data', (d) => { buf += d; if (buf.includes('\r\n')) { s.destroy(); resolve(buf.split('\r\n')[0]); } });
      s.on('error', reject);
    });
    assert.match(status, /401/);
    const h = await client.health();
    assert.deepEqual(h.agents, ['default'], 'still the original agent');
    assert.equal(bank.agent.ws.readyState, WebSocket.OPEN, 'the connected agent was not replaced');
    const ok = await connect(relay.token);
    assert.equal(ok.opened, true, 'the right token opens it');
    ok.ws.close();
  });
});

test('the dashboard page is served without a token (it carries no data) but its API is not, and the page sends the token as a bearer header', async () => {
  await withBank(async ({ relay }) => {
    const page = await fetch(url(relay, '/dashboard'));
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(!html.includes(relay.token), 'the token is never embedded in the page');
    assert.match(html, /location\.hash/);
    assert.match(html, /replaceState/, 'the fragment is cleared after it is read');
    assert.match(html, /authorization: 'Bearer '/);
    assert.equal((await call(relay, 'GET', '/dashboard/overview')).status, 401);
    assert.equal((await call(relay, 'GET', '/dashboard/overview', { token: relay.token })).status, 200);
  });
});

test('client: uses an explicit token, then WITNESSLOOP_TOKEN, then the token file; with none it gets 401 and says so', async () => {
  await withBank(async ({ relay }) => {
    const port = relay.port;
    assert.ok(await createClient({ port, token: relay.token }).health());
    await assert.rejects(createClient({ port, token: 'wrong' }).health(), (e) => e.status === 401);
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-tok-'));
    const file = path.join(d, 'token');
    assert.equal(resolveToken({ env: {}, file }), null, 'no token anywhere');
    fs.writeFileSync(file, relay.token + '\n');
    assert.equal(resolveToken({ env: {}, file }), relay.token, 'file, trimmed');
    assert.equal(resolveToken({ env: { WITNESSLOOP_TOKEN: 'from-env' }, file }), 'from-env');
    assert.equal(resolveToken({ token: 'explicit', env: { WITNESSLOOP_TOKEN: 'from-env' }, file }), 'explicit');
  });
});

test('CLI without a token exits non-zero with a 401; with the token it works', async () => {
  await withBank(async ({ relay }) => {
    const missing = path.join(os.tmpdir(), 'wl-no-such-token-file');
    const base = { ...process.env, WITNESSLOOP_PORT: String(relay.port), WITNESSLOOP_TOKEN_FILE: missing };
    delete base.WITNESSLOOP_TOKEN;
    const bare = await run(['health'], base);
    assert.notEqual(bare.status, 0);
    assert.match(bare.stderr, /relay token/);
    const wrong = await run(['health'], { ...base, WITNESSLOOP_TOKEN: 'nope' });
    assert.notEqual(wrong.status, 0);
    const good = await run(['health'], { ...base, WITNESSLOOP_TOKEN: relay.token });
    assert.equal(good.status, 0, good.stderr);
    assert.equal(JSON.parse(good.stdout).ok ?? true, true);
  });
});

test('token primitives: constant-time match rejects empty, non-string and near-miss values; a relay cannot be created without a token', async () => {
  const t = newToken();
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.notEqual(t, newToken());
  assert.equal(tokenMatches(t, t), true);
  for (const bad of [undefined, null, '', t.slice(1), t + 'a', t.toUpperCase(), 5]) assert.equal(tokenMatches(t, bad), false);
  assert.equal(tokenMatches('', ''), false, 'an empty secret never matches');
  assert.equal(bearerOf('Bearer abc'), 'abc');
  assert.equal(bearerOf('bearer abc'), null);
  assert.equal(bearerOf(undefined), null);
  await assert.rejects(createRelay({ port: 0, token: '' }), /needs a token/);
});

test('token file: restricted to the current user; on Windows icacls is invoked and its failure refuses to leave a readable token', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-tokfile-'));
  const file = path.join(d, 'sub', 'token');
  const calls = [];
  writeTokenFile(file, 'sekret', { platform: 'win32', user: 'alice', run: (cmd, args) => { calls.push([cmd, ...args]); } });
  assert.deepEqual(calls[0].slice(0, 1), ['icacls']);
  assert.ok(calls[0].includes('/inheritance:r'));
  assert.ok(calls[0].includes('alice:F'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'sekret');
  const bad = path.join(d, 'bad-token');
  assert.throws(() => writeTokenFile(bad, 'sekret', { platform: 'win32', user: 'alice', run: () => { throw new Error('access denied'); } }), /refusing to start with a token other users may read/);
  assert.equal(fs.existsSync(bad), false, 'no readable token is left behind');
  if (process.platform !== 'win32') {
    const p = path.join(d, 'posix-token');
    fs.writeFileSync(p, 'old', { mode: 0o644 });
    writeTokenFile(p, 'new');
    assert.equal(fs.statSync(p).mode & 0o777, 0o600, 'an existing file is tightened too');
  }
});
