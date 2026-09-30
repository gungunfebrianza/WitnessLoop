// 2.3: the annotation linter lists candidates, never verdicts, and its URL fetch cannot be widened by a caller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { lintHtml, lintTarget, NOTE } from '../src/lint.mjs';
import { findOp } from '../src/ops.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const kinds = (r) => r.candidates.map((c) => `${c.kind}:${c.line}`);

test('an unannotated POST form is listed with its line and target', () => {
  const r = lintHtml('<h1>x</h1>\n<form method="POST" action="/api/pay?x=1">\n  <button>Go</button>\n</form>');
  assert.deepEqual(kinds(r), ['form:2']);
  assert.match(r.candidates[0].reason, /POST to \/api\/pay/);
  assert.ok(!r.candidates[0].reason.includes('x=1'), 'the query string is not echoed');
  assert.equal(r.scanned.forms, 1);
  assert.equal(r.annotated, 0);
});

test('an annotation on the element or on any ancestor counts, like closest() in the page agent', () => {
  const own = lintHtml('<form method="post" data-wl-effect="irreversible"><button>Pay</button></form>');
  assert.deepEqual(own.candidates, []);
  assert.equal(own.annotated, 2, 'the form and the button inside it');
  const ancestor = lintHtml('<div data-wl-effect="irreversible"><button id="pay">Pay now</button><a href="/delete/3">Delete</a></div>');
  assert.deepEqual(ancestor.candidates, []);
  assert.equal(ancestor.annotated, 2);
  const sibling = lintHtml('<div data-wl-effect="irreversible"></div><button>Pay now</button>');
  assert.deepEqual(kinds(sibling), ['button:1'], 'a closed sibling covers nothing');
  const reversible = lintHtml('<form method="post" data-wl-effect="reversible"></form>');
  assert.deepEqual(reversible.candidates, [], 'an explicit declaration is the page speaking, whatever it says');
});

test('harmless things are not listed: GET search form, ordinary buttons and links, mailto', () => {
  const r = lintHtml(`<form action="/search"><input name="q"><button>Search</button></form>
    <button id="menu">Menu</button><a href="/about">About</a><a href="mailto:a@b.c">Contact</a><a href="#top">Top</a><button type="reset">Reset</button>`);
  assert.deepEqual(r.candidates, []);
  assert.equal(r.scanned.forms, 1);
});

test('side-effecting looking buttons, inputs and links are listed as candidates', () => {
  const r = lintHtml(`<button id="send">Send money</button>
<input type="submit" value="Confirm order">
<a href="/account/delete">remove it</a>
<a href="/plain">Unsubscribe</a>
<button aria-label="Delete row">x</button>`);
  assert.deepEqual(kinds(r), ['button:1', 'button:2', 'link:3', 'link:4', 'button:5']);
  assert.match(r.candidates[2].reason, /target \/account\/delete/);
  assert.match(r.candidates[3].reason, /text "Unsubscribe"/);
});

test('submit buttons inside an already-listed form are not listed again', () => {
  const r = lintHtml('<form method="post" action="/x"><button>Save</button><input type="submit" value="Send"></form>');
  assert.deepEqual(kinds(r), ['form:1']);
});

test('an unrecognised data-wl-effect value is reported (the gate fails closed on it) but is not a missing annotation', () => {
  const r = lintHtml('<button data-wl-effect="dangerous">Pay</button>');
  assert.deepEqual(r.candidates.map((c) => [c.kind, c.severity]), [['annotation', 'info']]);
  assert.match(r.candidates[0].reason, /unrecognised.*"dangerous".*irreversible/);
  assert.equal(r.unannotatedCandidates, 0);
});

test('comments, scripts and styles are not markup; malformed HTML does not throw', () => {
  const r = lintHtml(`<!-- <form method="post"><button>Pay</button></form> -->
<script>document.body.innerHTML = '<form method="post"><button>Pay</button></form>'; if (a < b) {}</script>
<style>.pay > button { color: red }</style>
<p>text`);
  assert.deepEqual(r.candidates, []);
  for (const junk of ['', '<', '<<<>>>', '<form method=post', '<a href="', '</div></div>', '<button><button>Pay', '<form method="post"', '\u0000<b\u0000>']) {
    assert.doesNotThrow(() => lintHtml(junk), JSON.stringify(junk));
  }
  assert.ok(lintHtml('<form method=post action=/x/y><button>Go').candidates.length >= 1, 'unquoted attributes and unclosed tags still parse');
});

test('the output always says candidates, not verdicts, and whether the agent is included', () => {
  const r = lintHtml('<script src="/witnessloop/inject.js"></script><button>Pay</button>');
  assert.equal(r.note, NOTE);
  assert.match(r.note, /Candidates, not verdicts/);
  assert.match(r.note, /clean result proves nothing/);
  assert.equal(r.injected, true);
  assert.equal(lintHtml('<button>Pay</button>').injected, false);
});

test('the example pages: the shop lists Pay; the bank (annotated) and the mailer list nothing', async () => {
  const shop = await lintTarget(path.join(ROOT, 'examples/shop/public/index.html'));
  assert.deepEqual(shop.candidates.map((c) => c.kind), ['button']);
  assert.match(shop.candidates[0].snippet, /id="pay"/);
  assert.equal((await lintTarget(path.join(ROOT, 'examples/bank/public/index.html'))).candidates.length, 0);
  const mailer = await lintTarget(path.join(ROOT, 'examples/mailer/public/index.html'));
  assert.deepEqual(mailer.candidates, [], JSON.stringify(mailer.candidates));
});

// a one-shot http.request fetch: no pooled sockets, so nothing is still closing when the runner force-exits
// (undici's keep-alive pool racing --test-force-exit aborts libuv on Windows)
const plainFetch = (url, init = {}) => new Promise((resolve, reject) => {
  const req = http.request(url, { method: init.method ?? 'GET', agent: false, headers: { connection: 'close' } }, (res) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve(new Response([204, 304].includes(res.statusCode) ? null : Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
  });
  req.on('error', reject);
  req.end();
});

test('URL targets: a local page is fetched with GET; other hosts and redirects are refused; a missing file or page fails loudly', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.method + ' ' + req.url);
    // connection: close, so no pooled client socket is still winding down when the runner force-exits (a libuv abort on Windows)
    if (req.url === '/redir') { res.writeHead(302, { location: 'http://example.com/', connection: 'close' }).end(); return; }
    if (req.url === '/gone') { res.writeHead(404, { connection: 'close' }).end('nope'); return; }
    res.writeHead(200, { 'content-type': 'text/html', connection: 'close' }).end('<form method="post" action="/buy"><button>Buy</button></form>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await lintTarget(`${base}/page`, { fetchImpl: plainFetch });
    assert.deepEqual(r.candidates.map((c) => c.kind), ['form']);
    assert.deepEqual(seen, ['GET /page'], 'one GET, nothing else');
    await assert.rejects(lintTarget(`${base}/redir`, { fetchImpl: plainFetch }), /redirects/);
    await assert.rejects(lintTarget(`${base}/gone`, { fetchImpl: plainFetch }), /404/);
    let called = false;
    const spy = async () => { called = true; return new Response('<button>Pay</button>'); };
    await assert.rejects(lintTarget('http://example.com/', { env: {}, fetchImpl: spy }), /only fetches loopback/);
    assert.equal(called, false, 'a remote host is refused before any request leaves');
    await assert.rejects(lintTarget('http://169.254.169.254/latest/meta-data', { env: {}, fetchImpl: spy }), /loopback/);
    const allowed = await lintTarget('http://example.com/', { env: { WITNESSLOOP_LINT_ALLOW_REMOTE: '1' }, fetchImpl: spy });
    assert.equal(called, true);
    assert.equal(allowed.candidates.length, 1, 'the human can opt in through the environment');
    await assert.rejects(lintTarget(path.join(os.tmpdir(), 'wl-no-such-page.html')), /ENOENT/);
    await assert.rejects(lintTarget(''), /needs a file or a URL/);
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    // let the client-side sockets finish closing: on Windows a forced exit (--test-force-exit) racing them aborts libuv
    await new Promise((r) => setTimeout(r, 100));
  }
});

test('the op is in the shared table (CLI and MCP), local, and an argument cannot turn on remote fetching', async () => {
  const op = findOp('lint-page');
  assert.ok(op && op.local && !op.cli);
  assert.deepEqual(op.pos, ['target']);
  assert.ok(!(op.flags ?? []).length && !(op.bools ?? []).length, 'no flag can widen what it may fetch');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-lint-'));
  const file = path.join(dir, 'p.html');
  fs.writeFileSync(file, '<button>Delete account</button>');
  const out = await op.run(null, { target: file, allowRemote: true });
  assert.equal(out.candidates.length, 1);
  await assert.rejects(op.run(null, { target: 'http://example.com/', allowRemote: true, env: { WITNESSLOOP_LINT_ALLOW_REMOTE: '1' } }), /loopback/);
});
