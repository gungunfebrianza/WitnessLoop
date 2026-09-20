// What witnessloop needs to know about the bank to judge it: an invariant and an effect check.
import { INITIAL_TOTAL, totalMoney } from './model.mjs';

export const profile = {
  name: 'bank',
  volatileKeys: ['at'], // transaction timestamps differ between a run and its replay
  // Money is conserved: balances + fees never change in total. (The planted rounding bug breaks this.)
  invariant: (world) => {
    const total = totalMoney(world.server);
    return total === INITIAL_TOTAL ? { ok: true } : { ok: false, why: `money not conserved: total ${total} != ${INITIAL_TOTAL} (${total - INITIAL_TOTAL} cents)` };
  },
  // The preview promised "to X, amount A": the recipient must have received exactly A.
  effectCheck: ({ preview, before, after }) => {
    const moved = after.server.balances[preview.to] - before.server.balances[preview.to];
    const promised = Math.round(Number(preview.amount) * 100);
    return moved === promised ? { ok: true } : { ok: false, why: `${preview.to} received ${moved} cents but the preview promised ${promised}` };
  },
};
export default profile;
