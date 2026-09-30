import { createRelay } from '../../src/relay.mjs';
import { createClient } from '../../src/client.mjs';
import { generateKey, fingerprint } from '../../src/attest.mjs';
import { startFakeBank, bankProfile } from './fake-agent.mjs';

// Runs fn with a live in-process relay + a connected fake bank agent, then cleans up.
export async function withBank(fn, relayOpts = {}, bankOpts = {}) {
  // approvals are signed: the relay registers one approver key and the client signs with it, unless a test says otherwise
  const approverKey = generateKey();
  const relay = await createRelay({ port: 0, profile: bankProfile, approvalTimeoutMs: 5000, approvers: [fingerprint(approverKey.publicKey)], ...relayOpts });
  await relay.listen();
  const client = createClient({ port: relay.port, approverKey, token: relay.token });
  const bank = await startFakeBank(relay.port, { token: relay.token, ...bankOpts });
  try {
    return await fn({ relay, client, bank, approverKey });
  } finally {
    await bank.close();
    await relay.close();
  }
}

// Same, plus a second bank named "shadow" (a disposable copy of the app for forks / replays).
export async function withBankPair(fn, relayOpts = {}) {
  return withBank(async (ctx) => {
    const shadow = await startFakeBank(ctx.relay.port, { name: 'shadow', token: ctx.relay.token });
    try { return await fn({ ...ctx, shadow }); } finally { await shadow.close(); }
  }, { policy: { default: 'allow' }, ...relayOpts });
}

export async function transferVia(client, to, amount, opts = {}) {
  await client.cmd('dom.fill', { selector: '#to', value: to }, opts);
  await client.cmd('dom.fill', { selector: '#amount', value: String(amount) }, opts);
  return client.cmd('dom.click', { selector: '#send' }, opts);
}

export async function waitFor(fn, { timeoutMs = 3000, everyMs = 20 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
