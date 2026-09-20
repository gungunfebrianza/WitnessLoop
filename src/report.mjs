// Markdown audit report for one session. Pure: hand it the hydrated events and it renders.
const cell = (v) => String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 90);
const short = (v) => cell(typeof v === 'string' ? v : JSON.stringify(v));

export function buildReport({ session, events, verify, causal, children = [] }) {
  const L = [];
  const start = events[0]?.data ?? {};
  L.push(`# witnessloop report - session ${session.id}`, '');
  L.push(`- goal: ${start.goal || '(none)'}`, `- actor: ${session.actor}   agent: ${session.agent}   status: ${session.status}`);
  if (session.parent_session) L.push(`- fork of session ${session.parent_session}`);
  L.push(`- chain: ${verify.ok ? `verified (${verify.checked} events, sealed through #${verify.sealedThrough}, signer ${verify.signers.join(', ') || 'none'})` : `BROKEN at event #${verify.badIdx}: ${verify.problems[0]?.reason}`}`, '');

  const commands = events.filter((e) => e.kind === 'command');
  const intents = events.filter((e) => e.kind === 'intent');
  const flags = events.filter((e) => e.kind === 'flag');
  const ran = new Set(commands.map((c) => c.data.intent_idx).filter((x) => x !== undefined));
  L.push('## Summary', '');
  L.push(`- commands executed: ${commands.length} (${commands.filter((c) => !c.ok).length} failed)`);
  L.push(`- irreversible intents: ${intents.length} (released ${intents.filter((i) => ran.has(i.idx)).length}, refused ${intents.filter((i) => !ran.has(i.idx)).length})`);
  L.push(`- effect mismatches flagged: ${flags.length}`, `- checkpoints: ${events.filter((e) => e.kind === 'checkpoint').length}`, '');

  if (intents.length) {
    L.push('## Gate decisions', '', '| intent | command | preview | decisions | executed |', '|---|---|---|---|---|');
    for (const i of intents) {
      const ds = events.filter((e) => e.kind === 'decision' && e.data.intent_idx === i.idx);
      L.push(`| #${i.idx} | ${cell(i.type)} | ${short(i.data.preview)} | ${ds.map((d) => `${d.data.verdict} by ${d.data.by ?? 'policy'}${d.data.reason ? ` (${cell(d.data.reason)})` : ''}`).join(' -> ')} | ${ran.has(i.idx) ? 'yes' : 'NO'} |`);
    }
    L.push('');
  }
  if (flags.length) {
    L.push('## Flags', '');
    for (const f of flags) L.push(`- #${f.idx} ${f.type}: command #${f.data.command_idx} - ${f.data.why}`);
    L.push('');
  }

  L.push('## Timeline', '', '| # | kind | type | effect | ok | note |', '|---|---|---|---|---|---|');
  for (const e of events.slice(0, 300)) {
    const d = e.data ?? {};
    const note = e.kind === 'command' ? short(d.params) : e.kind === 'checkpoint' ? `${d.label} ${String(d.state_hash).slice(0, 8)}` : e.kind === 'decision' ? d.verdict : e.kind === 'intent' ? short(d.preview) : '';
    L.push(`| ${e.idx} | ${e.kind} | ${cell(e.type)} | ${cell(e.effect)} | ${e.ok === null ? '' : e.ok ? 'y' : 'n'} | ${note} |`);
  }
  if (events.length > 300) L.push(`| ... | ${events.length - 300} more events | | | | |`);
  L.push('');

  if (causal) {
    const by = {};
    for (const e of causal.edges) by[e.kind] = (by[e.kind] ?? 0) + 1;
    L.push('## Causality', '', `Edges: ${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}. Edges marked *inferred* are heuristics, not recorded facts.`, '');
    for (const e of causal.edges.filter((x) => x.kind === 'derived_from').slice(0, 20)) L.push(`- #${e.effect} used \`${cell(e.detail.value)}\` (param ${e.detail.param}), first seen in the read at #${e.cause} *(inferred)*`);
    L.push('');
  }
  if (children.length) {
    L.push('## Forks of this session', '');
    for (const c of children) L.push(`- session ${c.id}: ${c.goal ?? ''} (${c.status})`);
    L.push('');
  }
  return L.join('\n');
}
