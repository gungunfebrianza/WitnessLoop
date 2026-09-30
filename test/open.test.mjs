import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { openCommand, openUrl, shouldOpen } from '../src/open.mjs';
import { findOp } from '../src/ops.mjs';
import { parseArgs } from '../src/cli.mjs';

test('shouldOpen: only for an interactive terminal, and every opt-out wins', () => {
  assert.equal(shouldOpen({ env: {}, isTTY: true }), true);
  assert.equal(shouldOpen({ env: {}, isTTY: false }), false, 'piped output');
  assert.equal(shouldOpen({ env: {}, isTTY: undefined }), false);
  assert.equal(shouldOpen({ noOpen: true, env: {}, isTTY: true }), false, '--no-open');
  assert.equal(shouldOpen({ env: { WITNESSLOOP_NO_OPEN: '1' }, isTTY: true }), false);
  assert.equal(shouldOpen({ env: { CI: 'true' }, isTTY: true }), false, 'CI');
});

test('openCommand picks the right launcher per platform and passes the url as one argument', () => {
  const url = 'http://127.0.0.1:8974/dashboard';
  assert.deepEqual(openCommand(url, 'win32'), { cmd: 'cmd', args: ['/c', 'start', '', url] });
  assert.deepEqual(openCommand(url, 'darwin'), { cmd: 'open', args: [url] });
  assert.deepEqual(openCommand(url, 'linux'), { cmd: 'xdg-open', args: [url] });
});

test('openUrl launches detached and never throws, even when the launcher is missing or throws', async () => {
  let seen;
  const fake = (cmd, args, opts) => { seen = { cmd, args, opts }; return { on() {}, unref() {} }; };
  assert.equal(openUrl('http://x/dashboard', { platform: 'linux', run: fake }), true);
  assert.equal(seen.cmd, 'xdg-open');
  assert.equal(seen.opts.detached, true);
  assert.equal(seen.opts.stdio, 'ignore');
  assert.equal(openUrl('http://x', { run: () => { throw new Error('boom'); } }), false);
  // a real spawn of a command that does not exist reports through 'error'; that must be swallowed
  const missing = openUrl('http://x', { platform: 'linux', run: (_c, a, o) => spawn('witnessloop-no-such-launcher', a, o) });
  assert.equal(missing, true);
  await new Promise((r) => setTimeout(r, 200));
});

test('serve accepts --no-open as a flag with no value', () => {
  const args = parseArgs(findOp('serve'), ['--no-open', '--port', '9001']);
  assert.equal(args.noOpen, true);
  assert.equal(args.port, '9001');
});
