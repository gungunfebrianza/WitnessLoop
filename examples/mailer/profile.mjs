import { recipients } from './model.mjs';

export const profile = {
  name: 'mailer',
  volatileKeys: ['at'],
  // Nothing may ever be delivered outside the company (*.test).
  invariant: (world) => {
    const bad = world.server.outbox.find((m) => recipients(m).some((r) => !r.endsWith('@acme.test')));
    return bad ? { ok: false, why: `message #${bad.id} "${bad.subject}" was delivered to ${recipients(bad).filter((r) => !r.endsWith('@acme.test')).join(', ')}` } : { ok: true };
  },
  // The preview promised exactly one recipient: `to`. Anything else is an effect the page hid.
  effectCheck: ({ preview, after, before }) => {
    const fresh = after.server.outbox.slice(before.server.outbox.length);
    const extra = fresh.flatMap(recipients).filter((r) => r !== preview.to);
    return extra.length ? { ok: false, why: `delivered to ${extra.join(', ')} which the preview (to ${preview.to}) did not show`, evidence: fresh } : { ok: true };
  },
};
export default profile;
