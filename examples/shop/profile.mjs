// What witnessloop needs to know about the shop: how to draw it, and one invariant.
import { INITIAL_BALANCE, spent } from './model.mjs';

export const profile = {
  name: 'shop',
  volatileKeys: ['at'],
  // Money is conserved: what is left plus what was spent is what the wallet started with.
  invariant: (world) => {
    const total = world.server.balance + spent(world.server);
    return total === INITIAL_BALANCE ? { ok: true } : { ok: false, why: `wallet not conserved: ${total} != ${INITIAL_BALANCE}` };
  },
  metrics: (world) => ({
    title: 'Wallet', unit: 'cents', parts: { balance: world.server.balance, spent: spent(world.server) },
    total: world.server.balance + spent(world.server), expected: INITIAL_BALANCE,
    itemsTitle: 'Every order', itemsNoun: 'orders', itemCols: ['amount', 'lost'],
    items: world.server.orders.map((o) => ({ label: `#${o.id} ${o.item}`, amount: o.cents, delta: 0 })),
  }),
};
export default profile;
