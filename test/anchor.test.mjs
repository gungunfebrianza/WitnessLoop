import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { generateKey } from '../src/attest.mjs';
import { Ledger, verifyBundle } from '../src/ledger.mjs';
import { fileSink, readAnchors } from '../src/anchor.mjs';
import { withBank, transferVia } from './helpers/relay.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wl-anchor-'));
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');

function history(l, note) {
  const sid = l.startSession({ goal: note, actor: 'tester' });
  for (let i = 0; i < 4; i++) l.append(sid, { kind: 'command', type: 'dom.click', effect: 'reversible', ok: true, data: { params: { i }, result: { note } } });
  l.endSession(sid);
  return sid;
}
const asRecord = (rec) => ({ session: rec.session, head_idx: rec.head_idx, head_hash: rec.head_hash, ts: rec.ts });

test('a rewrite of the whole history, resealed with the same key, passes plain verify but fails against the anchor', async () => {
  const key = generateKey();
  const original = new Ledger(':memory:', { key });
  const sid = history(original, 'what really happened');
  const file = path.join(tmp(), 'anchors.jsonl');
  const rec = original.anchorRecord(sid);
  await fileSink(file)({ session: rec.session, head_hash: rec.head_hash, seal: rec.seal });
  assert.equal(verifyBundle(original.bundle(sid), { anchors: readAnchors(file) }).ok, true, 'the honest history matches its anchor');

  // the key holder rebuilds the session with different content, in a fresh database, signing with the same key
  const forged = new Ledger(':memory:', { key });
  const fsid = history(forged, 'what I wish had happened');
  assert.equal(fsid, sid, 'same session id, same shape');
  const bundle = forged.bundle(fsid);
  assert.equal(verifyBundle(bundle).ok, true, 'plain verify passes: the forgery is internally consistent and correctly signed');
  const anchored = verifyBundle(bundle, { anchors: readAnchors(file) });
  assert.equal(anchored.ok, false);
  assert.ok(anchored.problems.some((p) => /differs from the anchored seal/.test(p.reason)), JSON.stringify(anchored.problems));
});

test('a history cut back before the anchored head is caught', () => {
  const key = generateKey();
  const l = new Ledger(':memory:', { key });
  const sid = history(l, 'x');
  const rec = l.anchorRecord(sid);
  const bundle = JSON.parse(JSON.stringify(l.bundle(sid)));
  bundle.events = bundle.events.slice(0, 3);
  bundle.seals = bundle.seals.filter((s) => s.head_idx < 3);
  const r = verifyBundle(bundle, { strict: false, anchors: [asRecord(rec)] });
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => /truncated relative to the anchor/.test(p.reason)), JSON.stringify(r.problems));
});

test('asking for anchors and having none for the session fails closed; unreadable or malformed anchor files are errors', () => {
  const key = generateKey();
  const l = new Ledger(':memory:', { key });
  const sid = history(l, 'x');
  assert.equal(verifyBundle(l.bundle(sid), { anchors: [] }).ok, false, 'no records at all');
  assert.equal(verifyBundle(l.bundle(sid), { anchors: [{ session: sid + 1, head_idx: 0, head_hash: '0'.repeat(64) }] }).ok, false, 'records for another session only');
  const d = tmp();
  assert.throws(() => readAnchors(path.join(d, 'missing.jsonl')), /ENOENT/);
  const bad = path.join(d, 'bad.jsonl');
  fs.writeFileSync(bad, '{"session":1,"head_idx":2,"head_hash":"zz"}\n');
  assert.throws(() => readAnchors(bad), /not an anchor record/);
  fs.writeFileSync(bad, 'not json\n');
  assert.throws(() => readAnchors(bad), /not valid JSON/);
});

test('relay: anchor records the seal head, the relay sink receives it, and verify with anchors runs on the relay', async () => {
  const seen = [];
  await withBank(async ({ client, relay }) => {
    const sid = await client.startSession({ goal: 'anchor me' });
    await transferVia(client, 'bob', 10);
    const rec = await client.anchor(sid);
    assert.equal(rec.sunk, true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].head_hash, rec.head_hash);
    assert.equal(relay.ledger.event(sid, rec.head_idx, { hydrate: false }).hash, rec.head_hash);
    await client.endSession(sid);
    assert.equal(seen.length, 2, 'the final seal is anchored as the session ends');
    const anchors = seen.map((s) => ({ session: s.session, head_idx: s.seal.head_idx, head_hash: s.head_hash, ts: s.seal.ts }));
    assert.equal((await client.verify(sid, { strict: true, anchors })).ok, true);
    const wrong = [{ ...anchors[0], head_hash: 'f'.repeat(64) }];
    const r = await client.verify(sid, { strict: true, anchors: wrong });
    assert.equal(r.ok, false);
    assert.match(r.problems[0].reason, /differs from the anchored seal/);
  }, { policy: { default: 'allow' }, anchorSink: async (x) => { seen.push(x); } });
});

test('relay: a failing sink is reported, never silently ignored', async () => {
  await withBank(async ({ client }) => {
    const sid = await client.startSession({});
    await assert.rejects(client.anchor(sid), /anchor sink failed: sink down/);
    await assert.rejects(client.endSession(sid), /anchor sink failed: sink down/);
  }, { anchorSink: async () => { throw new Error('sink down'); } });
});

test('CLI: verify-bundle --anchor fails for a forged bundle and passes for the real one', () => {
  const key = generateKey();
  const real = new Ledger(':memory:', { key });
  const sid = history(real, 'real');
  const d = tmp();
  const anchors = path.join(d, 'a.jsonl');
  fs.writeFileSync(anchors, JSON.stringify(asRecord(real.anchorRecord(sid))) + '\n');
  const good = path.join(d, 'good.wl.json');
  fs.writeFileSync(good, JSON.stringify(real.bundle(sid)));
  const forged = new Ledger(':memory:', { key });
  history(forged, 'forged');
  const bad = path.join(d, 'bad.wl.json');
  fs.writeFileSync(bad, JSON.stringify(forged.bundle(1)));
  const run = (f, ...extra) => spawnSync(process.execPath, [CLI, 'verify-bundle', f, ...extra], { encoding: 'utf8' });
  assert.equal(run(bad).status, 0, 'plain verify-bundle accepts the forgery');
  assert.equal(run(good, '--anchor', anchors).status, 0);
  assert.equal(run(bad, '--anchor', anchors).status, 1);
  assert.notEqual(run(good, '--anchor', path.join(d, 'nope.jsonl')).status, 0, 'missing anchor file is an error');
});

test('dashboard integrity shows anchor status from the real verifier: none, unanchored (fails closed), ok, and failed after a rewrite', async () => {
  const { withBank, transferVia } = await import('./helpers/relay.mjs');
  const { fileSink } = await import('../src/anchor.mjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wl-dashanchor-')), 'anchors.jsonl');
  const detail = (relay, sid) => fetch(`http://127.0.0.1:${relay.port}/dashboard/sessions/${sid}`, { headers: { authorization: `Bearer ${relay.token}` } }).then((r) => r.json()).then((j) => j.result.summary.integrity.anchor);
  await withBank(async ({ relay, client }) => {
    const sid = await client.startSession({});
    await transferVia(client, 'bob', 50);
    await client.endSession(sid);
    assert.equal((await detail(relay, sid)).state, 'unanchored', 'an anchor file with nothing for this session is not a pass');
    const r = await client.anchor(sid);
    await fileSink(file)({ session: r.session, head_hash: r.head_hash, seal: r.seal });
    assert.equal((await detail(relay, sid)).state, 'ok');
    // a rewritten history no longer matches the anchor
    fs.writeFileSync(file, JSON.stringify({ session: sid, head_idx: r.head_idx, head_hash: '0'.repeat(64), ts: 'x' }) + '\n');
    const bad = await detail(relay, sid);
    assert.equal(bad.state, 'failed');
    fs.writeFileSync(file, 'not json\n');
    assert.equal((await detail(relay, sid)).state, 'failed', 'an unreadable anchor file fails closed');
  }, { anchorFile: file });
  await withBank(async ({ relay, client }) => {
    const sid = await client.startSession({});
    assert.equal((await detail(relay, sid)).state, 'none');
  });
});
