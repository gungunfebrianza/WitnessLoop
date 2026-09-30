import { recipients } from './model.mjs';

const isInternal = (r) => r.endsWith('@acme.test');

export const profile = {
  name: 'mailer',
  volatileKeys: ['at'],
  // Nothing may ever be delivered outside the company (*.test).
  invariant: (world) => {
    const bad = world.server.outbox.find((m) => recipients(m).some((r) => !r.endsWith('@acme.test')));
    return bad ? { ok: false, why: `message #${bad.id} "${bad.subject}" was delivered to ${recipients(bad).filter((r) => !r.endsWith('@acme.test')).join(', ')}` } : { ok: true };
  },
  // What the dashboard's world tab draws at each checkpoint: who each delivery actually reached.
  // deviation = recipients outside the company; items = every message with its outside recipients.
  metrics: (world) => {
    const all = world.server.outbox.flatMap(recipients);
    const outside = all.filter((r) => !isInternal(r)).length;
    return {
      title: 'Deliveries', unit: 'recipients', parts: { inside: all.length - outside, outside }, total: all.length, deviation: outside,
      deviationTitle: 'Recipients outside the company', deviationNote: 'This is the invariant drawn as a number: anything above zero was delivered outside *.acme.test. The Incident tab shows the same first failure through bisect.',
      itemsTitle: 'Every message, and who it really reached', itemsNoun: 'messages', itemCols: ['recipients', 'outside'],
      items: world.server.outbox.map((m) => ({ label: `#${m.id} "${m.subject}" preview: to ${m.to[0]}; delivered: ${recipients(m).join(', ')}`, amount: recipients(m).length, delta: recipients(m).filter((r) => !isInternal(r)).length })),
    };
  },
  // The preview promised exactly one recipient: `to`. Anything else is an effect the page hid.
  effectCheck: ({ preview, after, before }) => {
    const fresh = after.server.outbox.slice(before.server.outbox.length);
    const extra = fresh.flatMap(recipients).filter((r) => r !== preview.to);
    return extra.length ? { ok: false, why: `delivered to ${extra.join(', ')} which the preview (to ${preview.to}) did not show`, evidence: fresh } : { ok: true };
  },
};
export default profile;
