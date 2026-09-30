#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { OPS, findOp } from './ops.mjs';
import { createClient } from './client.mjs';
import { createRelay, DEFAULT_PORT } from './relay.mjs';
import { loadOrCreateKey } from './attest.mjs';
import { openUrl, shouldOpen } from './open.mjs';
import { fileSink } from './anchor.mjs';
import { lintPolicy } from './policy.mjs';
import { writeTokenFile, DEFAULT_TOKEN_FILE } from './auth.mjs';

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

export function usageText() {
  const w = Math.max(...OPS.map((o) => (o.usage ?? o.name).length));
  return ['witnessloop <command> ...', '', ...OPS.map((o) => `  ${(o.usage ?? o.name).padEnd(w)}  ${o.desc}`), '',
    'Env: WITNESSLOOP_PORT (default 8974). Open an app page with ?witness=1 so its agent connects.'].join('\n');
}

// argv -> the same args object an MCP call would carry
export function parseArgs(op, argv) {
  const args = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const key = camel(a.slice(2));
    if (op.bools?.includes(key)) { args[key] = true; continue; }
    const known = op.flags?.includes(key);
    if (!known) throw new Error(`${op.name}: unknown flag ${a}\nusage: ${op.usage ?? op.name}`);
    const v = argv[++i];
    if (v === undefined) throw new Error(`${op.name}: ${a} needs a value`);
    if (op.multi?.includes(key)) (args[key] ??= []).push(v); else args[key] = v;
  }
  (op.pos ?? []).forEach((name, i) => { if (rest[i] !== undefined) args[name] = rest[i]; });
  if (rest.length > (op.pos ?? []).length) throw new Error(`${op.name}: unexpected argument "${rest[(op.pos ?? []).length]}"\nusage: ${op.usage ?? op.name}`);
  const missing = (op.pos ?? []).filter((n, i) => rest[i] === undefined && !(op.optPos ?? []).includes(n));
  if (missing.length) throw new Error(`${op.name}: missing <${missing[0]}>\nusage: ${op.usage ?? op.name}`);
  return args;
}

async function serve(a) {
  const dir = '.witnessloop';
  const port = a.port ? Number(a.port) : Number(process.env.WITNESSLOOP_PORT) || DEFAULT_PORT;
  let profile = {};
  if (a.profile) {
    const mod = await import(pathToFileURL(path.resolve(a.profile)).href);
    profile = mod.profile ?? mod.default ?? {};
  }
  const relay = await createRelay({
    dbPath: a.db ?? path.join(dir, 'ledger.db'), keyPath: a.key ?? path.join(dir, 'key.json'), port,
    policy: a.policy ? JSON.parse(fs.readFileSync(a.policy, 'utf8')) : null, profile,
    checkpoints: a.checkpoints ?? 'mutating', approvalTimeoutMs: a.approvalTimeoutMs ? Number(a.approvalTimeoutMs) : 300000,
    anchorSink: a.anchorSink ? fileSink(a.anchorSink) : null,
    approvers: a.approver ?? [], allowUnsignedApprovals: !!a.allowUnsignedApprovals,
  });
  for (const w of lintPolicy(relay.getPolicy())) console.warn(`policy warning: ${w.message}`);
  // the token file is written before the relay accepts anything, and a failure to protect it stops the start
  const tokenFile = process.env.WITNESSLOOP_TOKEN_FILE ?? DEFAULT_TOKEN_FILE;
  try { writeTokenFile(tokenFile, relay.token); } catch (e) { await relay.close(); throw e; }
  await relay.listen();
  console.log(`witnessloop relay listening on http://127.0.0.1:${relay.port}  (db ${a.db ?? path.join(dir, 'ledger.db')})`);
  const dashboard = `http://127.0.0.1:${relay.port}/dashboard`;
  console.log(`dashboard: ${dashboard}   (relay token in ${tokenFile}; clients read it from there or from WITNESSLOOP_TOKEN)`);
  console.log(a.approver?.length ? `approvals: signed by ${a.approver.length} registered approver key(s)${a.allowUnsignedApprovals ? ' OR unsigned (--allow-unsigned-approvals)' : ' only'}` : a.allowUnsignedApprovals ? 'approvals: UNSIGNED approvals allowed (--allow-unsigned-approvals)' : 'approvals: no approver key registered, so every approval will be refused; create one with keygen --role approver and pass --approver <fingerprint>');
  // the token rides in the URL fragment: it is never sent to a server, logged or put in a Referer; the page moves it into memory and clears it
  if (shouldOpen({ noOpen: a.noOpen })) openUrl(`${dashboard}#token=${relay.token}`);
  process.on('SIGINT', async () => { await relay.close(); process.exit(0); });
}

export async function main(argv) {
  const [name, ...rest] = argv;
  if (!name || name === '--help' || name === '-h' || name === 'help') { console.log(usageText()); return 0; }
  const op = findOp(name);
  if (!op) { console.error(`unknown command "${name}"\n\n${usageText()}`); return 2; }
  const args = parseArgs(op, rest);
  if (op.name === 'serve') { await serve(args); return null; }
  if (op.name === 'keygen') {
    if (args.role && !['signer', 'approver'].includes(args.role)) throw new Error('keygen: --role must be signer or approver');
    const approver = args.role === 'approver';
    const file = args.out ?? path.join('.witnessloop', approver ? 'approver.json' : 'key.json');
    const k = loadOrCreateKey(file);
    const { fingerprint } = await import('./attest.mjs');
    console.log(`${approver ? 'approver key' : 'key'} at ${file}, fingerprint ${fingerprint(k.publicKey)}`);
    if (approver) console.log(`register it with the relay:  witnessloop serve --approver ${fingerprint(k.publicKey)}   (keep ${file} away from the agent process)`);
    return 0;
  }
  const out = await op.run(createClient(), args);
  console.log(op.markdown ? out : JSON.stringify(out, null, 2));
  if ((op.name === 'verify' || op.name === 'verify-bundle') && out.ok === false) return 1;
  if (op.name === 'replay-verify' && out.reproduced === false) return 1;
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => { if (code !== null) process.exit(code); }, (e) => { console.error(`witnessloop: ${e.message}`); process.exit(1); });
}
