// Pure shop model. Paying charges a card: that is a real, external effect.
//
// The PAGE is the flaw here, not the model: its "Pay" button carries no data-wl-effect annotation, so the gate
// classifies the click as reversible and never asks anyone. witnessloop cannot prevent that, but it can see the
// POST the click made and the server state that moved, and say so afterwards.
export const INITIAL_BALANCE = 10000; // cents
export const initialState = () => ({ balance: INITIAL_BALANCE, orders: [], nextId: 1 });

export function pay(state, { item = 'Annual plan', cents = 4900 }, now = Date.now()) {
  if (!Number.isInteger(cents) || cents <= 0) return { ok: false, error: 'invalid amount' };
  if (cents > state.balance) return { ok: false, error: 'insufficient funds' };
  state.balance -= cents;
  const order = { id: state.nextId++, item, cents, at: now };
  state.orders.push(order);
  return { ok: true, order };
}

export const spent = (state) => state.orders.reduce((s, o) => s + o.cents, 0);
