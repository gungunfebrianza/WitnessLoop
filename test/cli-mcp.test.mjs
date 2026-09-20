import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { OPS, mcpOps, mcpName, parseOverride } from '../src/ops.mjs';
import { parseArgs, usageText } from '../src/cli.mjs';
import { toolDefinition, handle, callTool } from '../src/mcp-server.mjs';
import { createClient } from '../src/client.mjs';
import { withBankPair, transferVia } from './helpers/relay.mjs';

const run = promisify(execFile);
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');
const opOf = (n) => OPS.find((o) => o.name === n);

test('parity: every op is a CLI command with usage text, and is an MCP action unless CLI-only', () => {
  const help = usageText();
  const tool = toolDefinition();
  for (const o of OPS) {
    assert.ok(o.desc && o.desc.length > 10, `${o.name} needs a description`);
    assert.ok(help.includes(o.usage ?? o.name), `${o.name} missing from help`);
    if (o.cli) assert.ok(!tool.inputSchema.properties.action.enum.includes(mcpName(o)), `${o.name} is CLI-only`);
    else assert.ok(tool.inputSchema.properties.action.enum.includes(mcpName(o)), `${o.name} missing from MCP`);
  }
  assert.deepEqual(OPS.filter((o) => o.cli).map((o) => o.name).sort(), ['keygen', 'serve'], 'only process-lifecycle ops are CLI-only');
  assert.equal(mcpOps().length, OPS.length - 2);
  assert.ok(tool.description.length < 4000, 'tool description stays small');
});

test('parseArgs maps positionals and flags to the same args an MCP call carries', () => {
  assert.deepEqual(parseArgs(opOf('fork'), ['3', '--shadow', 'shadow', '--override', '12.value=10', '--override', '14.to=carol', '--force-same', '--skip', '5,6']),
    { id: '3', shadow: 'shadow', override: ['12.value=10', '14.to=carol'], forceSame: true, skip: '5,6' });
  assert.deepEqual(parseArgs(opOf('cmd'), ['dom.click', '{"selector":"#send"}', '--agent', 'x']), { type: 'dom.click', params: '{"selector":"#send"}', agent: 'x' });
  assert.deepEqual(parseArgs(opOf('cmd'), ['ping']), { type: 'ping' });
  assert.throws(() => parseArgs(opOf('verify'), []), /missing <id>/);
  assert.throws(() => parseArgs(opOf('verify'), ['1', '--bogus']), /unknown flag --bogus/);
  assert.throws(() => parseArgs(opOf('verify'), ['1', '2']), /unexpected argument/);
  assert.throws(() => parseArgs(opOf('fork'), ['1', '--shadow']), /needs a value/);
});

test('parseOverride builds { idx: { param: value } } and rejects garbage', () => {
  assert.deepEqual(parseOverride(['12.value=10.00', '12.to=bob', '3.params.x=1']), { 12: { value: '10.00', to: 'bob' }, 3: { 'params.x': '1' } });
  assert.deepEqual(parseOverride({ 1: { a: 1 } }), { 1: { a: 1 } });
  assert.throws(() => parseOverride(['nope']), /bad --override/);
});

test('MCP: initialize, tools/list, and a full session through tools/call', async () => {
  await withBankPair(async ({ relay }) => {
    const client = createClient({ port: relay.port });
    const init = await handle({ method: 'initialize', params: { protocolVersion: '2025-01-01' } }, client);
    assert.equal(init.serverInfo.name, 'witnessloop');
    assert.equal((await handle({ method: 'tools/list' }, client)).tools[0].name, 'witnessloop');
    const call = async (action, params) => {
      const r = await handle({ method: 'tools/call', params: { name: 'witnessloop', arguments: { action, params } } }, client);
      return { ...r, text: r.content[0].text };
    };
    const start = await call('session_start', { goal: 'via mcp' });
    const id = JSON.parse(start.text).id;
    await transferVia(client, 'bob', 100);
    await call('session_end', { id });
    const v = JSON.parse((await call('verify', { id, strict: true })).text);
    assert.equal(v.ok, true);
    const rep = await call('report', { id });
    assert.match(rep.text, /# witnessloop report/);
    const bad = await call('serve', {});
    assert.equal(bad.isError, true);
    assert.match(bad.text, /unknown action/);
    assert.equal((await call('nope', {})).isError, true);
    await assert.rejects(callTool({ action: 'keygen' }, client), /unknown action/);
    assert.equal(await handle({ method: 'wat' }, client), undefined);
  });
});

test('CLI end to end: export -> verify-bundle offline -> tamper one byte -> non-zero exit at the exact event', async () => {
  await withBankPair(async ({ relay, client }) => {
    const env = { ...process.env, WITNESSLOOP_PORT: String(relay.port) };
    const sid = await client.startSession({ goal: 'cli' });
    await transferVia(client, 'bob', 100);
    await client.endSession(sid);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wl-'));
    const file = path.join(dir, 's.wl.json');
    const { stdout } = await run('node', [CLI, 'export', String(sid), '--out', file], { env });
    assert.match(stdout, /"written"/);

    const ok = spawnSync('node', [CLI, 'verify-bundle', file], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(JSON.parse(ok.stdout).ok, true);

    const bundle = JSON.parse(fs.readFileSync(file, 'utf8'));
    const target = bundle.events.find((e) => e.kind === 'command' && e.type === 'dom.click');
    bundle.blobs[target.data_hash] = bundle.blobs[target.data_hash].replace('#send', '#sent');
    fs.writeFileSync(file, JSON.stringify(bundle));
    const bad = spawnSync('node', [CLI, 'verify-bundle', file], { encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.equal(JSON.parse(bad.stdout).badIdx, target.idx);

    const help = spawnSync('node', [CLI, '--help'], { encoding: 'utf8' });
    assert.match(help.stdout, /replay-verify/);
    const unk = spawnSync('node', [CLI, 'frobnicate'], { encoding: 'utf8' });
    assert.equal(unk.status, 2);
    const cmd = await run('node', [CLI, 'health'], { env });
    assert.ok(JSON.parse(cmd.stdout).agents.includes('default'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test('CLI reports an unreachable relay with the fix, not a stack trace', () => {
  const r = spawnSync('node', [CLI, 'health'], { encoding: 'utf8', env: { ...process.env, WITNESSLOOP_PORT: '1' } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cannot reach the witnessloop relay.*witnessloop serve/);
  assert.ok(!/at .*\.mjs:\d+/.test(r.stderr));
});
