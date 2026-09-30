// What witnessloop needs to know about the bank to judge it: an invariant and an effect check.
import { INITIAL_TOTAL, totalMoney, feeFor, fmt } from './model.mjs';

export const profile = {
  name: 'bank',
  volatileKeys: ['at'], // transaction timestamps differ between a run and its replay
  // Money is conserved: balances + fees never change in total. (The planted rounding bug breaks this.)
  invariant: (world) => {
    const total = totalMoney(world.server);
    return total === INITIAL_TOTAL ? { ok: true } : { ok: false, why: `money not conserved: total ${total} != ${INITIAL_TOTAL} (${total - INITIAL_TOTAL} cents)` };
  },
  // What the dashboard's world tab draws at each checkpoint: where the money is, and whether it adds up.
  // items: every transfer so far, with the cents it silently lost (fee charged minus fee booked).
  metrics: (world) => ({
    title: 'Money', unit: 'cents',
    parts: { ...world.server.balances, fees: world.server.fees },
    total: totalMoney(world.server), expected: INITIAL_TOTAL,
    items: world.server.txs.map((tx) => ({ label: `#${tx.id} ${tx.from} -> ${tx.to} ${fmt(tx.cents)}`, amount: tx.cents, delta: -(tx.fee - feeFor(tx.cents).booked) })),
  }),
  // The preview promised "to X, amount A": the recipient must have received exactly A.
  effectCheck: ({ preview, before, after }) => {
    const moved = after.server.balances[preview.to] - before.server.balances[preview.to];
    const promised = Math.round(Number(preview.amount) * 100);
    return moved === promised ? { ok: true } : { ok: false, why: `${preview.to} received ${moved} cents but the preview promised ${promised}` };
  },
};
export default profile;
