// Launch a real headless Chromium/Edge/Chrome over raw CDP (no dependencies) so the example
// pages, and the in-page agent inside them, can be driven end to end.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const WIN = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'];
const MAC = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium'];
const LINUX = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];

export function findBrowser() {
  if (process.env.WITNESSLOOP_BROWSER) return process.env.WITNESSLOOP_BROWSER;
  if (process.platform === 'win32') return WIN.find((p) => fs.existsSync(p)) ?? null;
  if (process.platform === 'darwin') return MAC.find((p) => fs.existsSync(p)) ?? null;
  return LINUX.find((n) => spawnSync('which', [n]).status === 0) ?? null;
}

// Returns a skip reason, or null when a browser is available. WITNESSLOOP_REQUIRE_BROWSER=1 makes a
// missing browser a hard failure instead of a skip.
export function browserSkip() {
  if (findBrowser()) return null;
  if (process.env.WITNESSLOOP_REQUIRE_BROWSER === '1') throw new Error('WITNESSLOOP_REQUIRE_BROWSER=1 but no browser was found');
  return 'no Chromium/Edge/Chrome found (set WITNESSLOOP_BROWSER)';
}

const freePort = () => new Promise((res, rej) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  s.on('error', rej);
});

export async function launchBrowser() {
  const exe = findBrowser();
  if (!exe) throw new Error('no browser found');
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-browser-'));
  const args = ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--window-size=1200,900'];
  if (process.platform === 'linux') args.push('--no-sandbox');
  const proc = spawn(exe, [...args, 'about:blank'], { stdio: 'ignore' });

  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* not up yet */ }
    if (!target) await new Promise((r) => setTimeout(r, 100));
  }
  if (!target) { proc.kill(); throw new Error('browser did not expose a page target'); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP connect failed')); });
  let id = 0;
  const waiting = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.rej(new Error(m.error.message)) : w.res(m.result); }
    else if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
    else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
  };
  const call = (method, params = {}) => new Promise((res, rej) => { const i = ++id; waiting.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  await call('Runtime.enable');
  await call('Page.enable');

  return {
    errors,
    navigate: (url) => call('Page.navigate', { url }),
    evaluate: async (expression) => {
      const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    close: async () => {
      try { ws.close(); } catch { /* already closed */ }
      proc.kill();
      await new Promise((r) => setTimeout(r, 200));
      try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Windows may still hold a lock */ }
    },
  };
}
