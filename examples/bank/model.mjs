// Pure bank model shared by the example server and the tests. Money is integer cents.
//
// PLANTED BUG (the thing witnessloop should find): a transfer charges the sender a 1.5% fee
// rounded HALF UP, but books to the fee account the fee rounded DOWN. Whenever the exact fee
// has a fractional part >= .5 cents, one cent silently disappears, so
//   sum(balances) + fees  is no longer constant.
// $1.00 leaks (1.5c -> charged 2, booked 1); $100.00 does not (150c exact).
export const INITIAL_TOTAL = 100000 + 50000 + 25000;
export const initialState = () => ({ balances: { alice: 100000, bob: 50000, carol: 25000 }, fees: 0, nextId: 1, txs: [] });

export const toCents = (amount) => Math.round(Number(amount) * 100);
export const fmt = (cents) => (cents / 100).toFixed(2);

export function feeFor(cents) {
  const charged = Math.floor((cents * 3 + 100) / 200);
  const booked = Math.floor((cents * 3) / 200);
  return { charged, booked };
}

export function transfer(state, { from = 'alice', to, amount, memo = '' }, now = Date.now()) {
  const cents = toCents(amount);
  if (!Number.isInteger(cents) || cents <= 0) return { ok: false, error: 'amount must be positive' };
  if (!(from in state.balances) || !(to in state.balances)) return { ok: false, error: 'unknown account' };
  if (from === to) return { ok: false, error: 'cannot pay yourself' };
  const { charged, booked } = feeFor(cents);
  if (state.balances[from] < cents + charged) return { ok: false, error: 'insufficient funds' };
  state.balances[from] -= cents + charged;
  state.balances[to] += cents;
  state.fees += booked;
  const tx = { id: state.nextId++, from, to, cents, fee: charged, memo, at: now };
  state.txs.push(tx);
  return { ok: true, tx };
}

export const totalMoney = (state) => Object.values(state.balances).reduce((a, b) => a + b, 0) + state.fees;
