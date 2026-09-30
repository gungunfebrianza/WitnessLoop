// One table drives both the CLI and the MCP server, so they cannot drift apart:
// every op here is a CLI command AND an MCP action unless it says otherwise.
import fs from 'node:fs';
import { verifyBundle } from './ledger.mjs';
import { readKey } from './attest.mjs';
import { fileSink, readAnchors } from './anchor.mjs';
import { lintTarget } from './lint.mjs';

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

// --anchor files (one or many) -> the records the verifier checks; unreadable or malformed files throw, never mean "no anchors"
const anchorsOf = (v) => (v === undefined ? null : [].concat(v).flatMap((f) => readAnchors(String(f))));

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
  { name: 'approve', pos: ['id'], flags: ['by', 'reason', 'key'], usage: 'approve <intent-id> [--key <approver.json>] [--by <name>] [--reason <text>]', desc: 'Release a pending irreversible action, signed with an approver key (keygen --role approver).', run: (c, a) => c.approve(a.id, { by: a.by, reason: a.reason }, { key: a.key ? readKey(a.key) : undefined }) },
  { name: 'deny', pos: ['id'], flags: ['by', 'reason', 'key'], usage: 'deny <intent-id> [--key <approver.json>] [--by <name>] [--reason <text>]', desc: 'Refuse a pending irreversible action.', run: (c, a) => c.deny(a.id, { by: a.by, reason: a.reason }, { key: a.key ? readKey(a.key) : undefined }) },
  { name: 'policy', usage: 'policy [<file.json|json>] [--dry-run <session>]', pos: ['policy'], optPos: ['policy'], flags: ['dryRun'], desc: 'Show the gate policy, or replace it. With --dry-run <session>: what the given (or current) policy would have decided for every recorded intent, plus shadowed-rule and regex warnings. Changes nothing.',
    run: (c, a) => (a.dryRun !== undefined ? c.policyDryRun(num(a.dryRun), a.policy === undefined ? undefined : parseJsonOrFile(a.policy, 'policy')) : a.policy === undefined ? c.getPolicy() : c.setPolicy(parseJsonOrFile(a.policy, 'policy'))) },
  { name: 'checkpoint', flags: ['agent', 'label'], usage: 'checkpoint [--agent <name>] [--label <text>]', desc: 'Capture the world now.', run: (c, a) => c.checkpoint(a.agent, a.label) },
  { name: 'verify', pos: ['id'], flags: ['anchor', 'trustedKey', 'trustedApprover'], bools: ['strict'], multi: ['anchor', 'trustedKey', 'trustedApprover'], usage: 'verify <session> [--strict] [--anchor <file>]... [--trusted-key <fingerprint>]... [--trusted-approver <fingerprint>]...', desc: 'Verify a session chain and seals in the ledger; with --anchor also check the history against seals copied outside it.',
    run: (c, a) => c.verify(num(a.id), { strict: !!a.strict, anchors: anchorsOf(a.anchor), trustedKeys: a.trustedKey ? [].concat(a.trustedKey) : null, trustedApprovers: a.trustedApprover ? [].concat(a.trustedApprover) : null }) },
  { name: 'verify-bundle', pos: ['file'], flags: ['trustedKey', 'trustedApprover', 'anchor'], multi: ['anchor', 'trustedKey', 'trustedApprover'], usage: 'verify-bundle <file.wl.json> [--trusted-key <fingerprint>]... [--trusted-approver <fingerprint>]... [--anchor <file>]...', local: true,
    desc: 'Verify an exported bundle offline: no relay, no database.',
    run: (_c, a) => verifyBundle(JSON.parse(fs.readFileSync(a.file, 'utf8')), { trustedKeys: a.trustedKey ? [].concat(a.trustedKey) : null, trustedApprovers: a.trustedApprover ? [].concat(a.trustedApprover) : null, anchors: anchorsOf(a.anchor) }) },
  // In the shared table, so also MCP actions (the parity rule). Anyone holding the relay token can rotate or revoke: see THREAT-MODEL.
  { name: 'rotate-key', usage: 'rotate-key', desc: 'Switch the relay to a new signing key; the old key signs the handover, and active sessions record it.', run: (c) => c.rotateKey() },
  { name: 'revoke-key', pos: ['fingerprint'], usage: 'revoke-key <fingerprint>', desc: 'Declare a key untrusted for seals made after this point in every active session (the current key cannot be revoked; rotate first).', run: (c, a) => c.revokeKey(a.fingerprint) },
  { name: 'anchor', pos: ['id'], flags: ['sink'], usage: 'anchor <session> [--sink <file>]', desc: 'Seal the session head and copy the seal hash outside the ledger (to --sink on this machine, and to the relay sink if it has one).',
    run: async (c, a) => { const r = await c.anchor(num(a.id)); if (a.sink) await fileSink(a.sink)({ session: r.session, head_hash: r.head_hash, seal: r.seal }); return { session: r.session, head_idx: r.head_idx, head_hash: r.head_hash, ts: r.ts, relaySink: r.sunk, ...(a.sink ? { written: a.sink } : {}) }; } },
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
  { name: 'lint-page', pos: ['target'], usage: 'lint-page <file|url>', local: true, desc: 'List forms, buttons and links that look like they change something but carry no data-wl-effect. Candidates, not verdicts; only loopback URLs unless WITNESSLOOP_LINT_ALLOW_REMOTE=1.', run: (_c, a) => lintTarget(a.target) },
  { name: 'detect', pos: ['id'], usage: 'detect <session>', desc: 'Reversible clicks whose recorded consequences look external (server state changed, or a write was observed). Detection after the fact, not prevention.', run: (c, a) => c.detect(num(a.id)) },
  { name: 'report', pos: ['id'], usage: 'report <session>', desc: 'Markdown audit report.', markdown: true, run: async (c, a) => (await c.report(num(a.id))).markdown },
  { name: 'serve', cli: true, flags: ['port', 'db', 'key', 'policy', 'profile', 'checkpoints', 'approvalTimeoutMs', 'anchorSink', 'approver'], bools: ['noOpen', 'allowUnsignedApprovals'], multi: ['approver'],
    usage: 'serve [--port N] [--db <file>] [--key <file>] [--policy <file>] [--profile <module>] [--checkpoints mutating|irreversible|none] [--approval-timeout-ms N] [--anchor-sink <file>] [--approver <fingerprint>]... [--allow-unsigned-approvals] [--no-open]',
    desc: 'Start the relay and open the dashboard in your browser (skipped with --no-open, WITNESSLOOP_NO_OPEN=1, CI, or piped output).' },
  { name: 'keygen', cli: true, flags: ['out', 'role'], usage: 'keygen [--role signer|approver] [--out <file>]', desc: 'Create the relay signing key (default .witnessloop/key.json) or, with --role approver, an approver key (default .witnessloop/approver.json).' },
];

export const mcpName = (op) => op.name.replace(/-/g, '_');
export const mcpOps = () => OPS.filter((o) => !o.cli);
export const findOp = (name) => OPS.find((o) => o.name === name || mcpName(o) === name);
