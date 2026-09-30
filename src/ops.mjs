// One table drives both the CLI and the MCP server, so they cannot drift apart:
// every op here is a CLI command AND an MCP action unless it says otherwise.
import fs from 'node:fs';
import { verifyBundle } from './ledger.mjs';

const num = (v) => (v === undefined || v === null || v === '' ? v : Number(v));

// --override 12.value=10.00  ->  { "12": { "value": "10.00" } }
export function parseOverride(v) {
  if (v === undefined) return undefined;
  if (typeof v === 'object' && !Array.isArray(v)) return v;
  const out = {};
  for (const item of [].concat(v)) {
    const m = /^(\d+)\.(.+?)=(.*)$/.exec(item);
    if (!m) throw new Error(`bad --override "${item}" (expected <eventIdx>.<param>=<value>, e.g. 12.value=10.00)`);
    (out[m[1]] ??= {})[m[2]] = m[3];
  }
  return out;
}

function parseJsonOrFile(v, what) {
  if (v === undefined || typeof v === 'object') return v;
  const text = String(v).trim().startsWith('{') ? String(v) : fs.readFileSync(String(v), 'utf8');
  try { return JSON.parse(text); } catch (e) { throw new Error(`${what} is not valid JSON: ${e.message}`); }
}

export const OPS = [
  { name: 'health', desc: 'Relay status: connected agents and session count.', run: (c) => c.health() },
  { name: 'agents', desc: 'List connected browser agents.', run: (c) => c.agents() },
  { name: 'session-start', flags: ['goal', 'agent', 'actor'], usage: 'session-start [--goal <text>] [--agent <name>] [--actor <name>]',
    desc: 'Open a session for an agent; records a genesis world checkpoint.', run: async (c, a) => ({ id: await c.startSession(a) }) },
  { name: 'session-end', pos: ['id'], usage: 'session-end <id>', desc: 'End and seal a session.', run: (c, a) => c.endSession(num(a.id), a.summary) },
  { name: 'sessions', desc: 'List sessions.', run: (c) => c.sessions() },
  { name: 'cmd', pos: ['type', 'params'], optPos: ['params'], flags: ['agent', 'actor'], usage: 'cmd <type> [<params-json>] [--agent <name>] [--actor <name>]',
    desc: 'Run a page command. Irreversible clicks go through the gate and may wait for approval.',
    run: (c, a) => c.cmd(a.type, parseJsonOrFile(a.params, 'params') ?? {}, { agent: a.agent, actor: a.actor }) },
  { name: 'intents', desc: 'Irreversible actions waiting for a human decision.', run: (c) => c.pending() },
  { name: 'approve', pos: ['id'], flags: ['by', 'reason'], usage: 'approve <intent-id> [--by <name>] [--reason <text>]', desc: 'Release a pending irreversible action.', run: (c, a) => c.approve(a.id, { by: a.by, reason: a.reason }) },
  { name: 'deny', pos: ['id'], flags: ['by', 'reason'], usage: 'deny <intent-id> [--by <name>] [--reason <text>]', desc: 'Refuse a pending irreversible action.', run: (c, a) => c.deny(a.id, { by: a.by, reason: a.reason }) },
  { name: 'policy', usage: 'policy [<file.json|json>]', pos: ['policy'], optPos: ['policy'], desc: 'Show the gate policy, or replace it.', run: (c, a) => (a.policy === undefined ? c.getPolicy() : c.setPolicy(parseJsonOrFile(a.policy, 'policy'))) },
  { name: 'checkpoint', flags: ['agent', 'label'], usage: 'checkpoint [--agent <name>] [--label <text>]', desc: 'Capture the world now.', run: (c, a) => c.checkpoint(a.agent, a.label) },
  { name: 'verify', pos: ['id'], bools: ['strict'], usage: 'verify <session> [--strict]', desc: 'Verify a session chain and seals in the ledger.', run: (c, a) => c.verify(num(a.id), !!a.strict) },
  { name: 'verify-bundle', pos: ['file'], flags: ['trustedKey'], usage: 'verify-bundle <file.wl.json> [--trusted-key <fingerprint>]', local: true,
    desc: 'Verify an exported bundle offline: no relay, no database.',
    run: (_c, a) => verifyBundle(JSON.parse(fs.readFileSync(a.file, 'utf8')), { trustedKey: a.trustedKey ?? null }) },
  { name: 'export', pos: ['id'], flags: ['out'], usage: 'export <session> [--out <file.wl.json>]', desc: 'Export a self-contained, verifiable bundle.',
    run: async (c, a) => { const b = await c.bundle(num(a.id)); if (!a.out) return b; fs.writeFileSync(a.out, JSON.stringify(b)); return { written: a.out, events: b.events.length, seals: b.seals.length }; } },
  { name: 'causal', pos: ['id'], usage: 'causal <session>', desc: 'Causal graph (recorded and inferred edges).', run: (c, a) => c.causal(num(a.id)) },
  { name: 'bisect', pos: ['id'], flags: ['search'], usage: 'bisect <session> [--search linear|binary]', desc: 'First event after which the app invariant broke.', run: (c, a) => c.bisect(num(a.id), { search: a.search }) },
  { name: 'fork', pos: ['id'], flags: ['at', 'shadow', 'override', 'skip', 'policy'], bools: ['forceSame'], multi: ['override'],
    usage: 'fork <session> --shadow <agent> [--at <eventIdx>] [--override <idx>.<param>=<v>]... [--skip <idx,idx>] [--policy <file.json>] [--force-same]',
    desc: 'Restore a checkpoint into a SHADOW agent and re-run, optionally changing a param, skipping a step or using another policy.',
    run: (c, a) => c.fork(num(a.id), {
      shadow: a.shadow, at: num(a.at), override: parseOverride(a.override), forceSame: !!a.forceSame,
      skip: a.skip === undefined ? undefined : [].concat(a.skip).flatMap((s) => String(s).split(',')).map(Number),
      policy: parseJsonOrFile(a.policy, 'policy'),
    }) },
  { name: 'replay-verify', pos: ['id'], flags: ['shadow'], usage: 'replay-verify <session> --shadow <agent>', desc: 'Re-run a session unchanged on a shadow agent and check it reproduces.', run: (c, a) => c.replayVerify(num(a.id), { shadow: a.shadow }) },
  { name: 'compare', pos: ['a', 'b'], usage: 'compare <sessionA> <sessionB>', desc: 'First divergence and world diff between two sessions.', run: (c, a) => c.compare(num(a.a), num(a.b)) },
  { name: 'report', pos: ['id'], usage: 'report <session>', desc: 'Markdown audit report.', markdown: true, run: async (c, a) => (await c.report(num(a.id))).markdown },
  { name: 'serve', cli: true, flags: ['port', 'db', 'key', 'policy', 'profile', 'checkpoints', 'approvalTimeoutMs'], bools: ['noOpen'],
    usage: 'serve [--port N] [--db <file>] [--key <file>] [--policy <file>] [--profile <module>] [--checkpoints mutating|irreversible|none] [--approval-timeout-ms N] [--no-open]',
    desc: 'Start the relay and open the dashboard in your browser (skipped with --no-open, WITNESSLOOP_NO_OPEN=1, CI, or piped output).' },
  { name: 'keygen', cli: true, flags: ['out'], usage: 'keygen [--out <file>]', desc: 'Create the signing key (default .witnessloop/key.json).' },
];

export const mcpName = (op) => op.name.replace(/-/g, '_');
export const mcpOps = () => OPS.filter((o) => !o.cli);
export const findOp = (name) => OPS.find((o) => o.name === name || mcpName(o) === name);
