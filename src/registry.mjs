// Every command an agent can run, and what kind of consequence it can have.
//   read          no state change
//   reversible    changes state, undone by restoring a checkpoint
//   irreversible  leaves the sandbox (money moves, message sent): gated, proof before consequence
//   dynamic       decided per target: the element's own data-wl-effect annotation (default reversible)
// There is deliberately no `eval`: an unbounded write cannot be classified, so it cannot be gated.
export const EFFECTS = ['read', 'reversible', 'irreversible'];

export const COMMANDS = {
  ping: { effect: 'read' },
  'page.info': { effect: 'read' },
  'dom.query': { effect: 'read' },
  'dom.describe': { effect: 'read' },
  'dom.text': { effect: 'read' },
  'dom.wait': { effect: 'read', longPoll: true },
  'dom.click': { effect: 'dynamic' },
  'dom.fill': { effect: 'reversible' },
  'page.reload': { effect: 'reversible' },
  'world.capture': { effect: 'read', internal: true },
  'world.restore': { effect: 'reversible', internal: true },
};

export const DEFAULT_TIMEOUT_MS = 15000;

export function timeoutFor(type, params = {}) {
  if (COMMANDS[type]?.longPoll) return (Number(params.timeoutMs) || 5000) + 5000;
  if (type.startsWith('world.')) return 30000;
  return DEFAULT_TIMEOUT_MS;
}

export function classify(type, describe) {
  const def = COMMANDS[type];
  if (!def) return null;
  if (def.effect !== 'dynamic') return def.effect;
  const e = describe?.effect;
  return EFFECTS.includes(e) && e !== 'read' ? e : 'reversible';
}

export const publicTypes = () => Object.keys(COMMANDS).filter((t) => !COMMANDS[t].internal);
