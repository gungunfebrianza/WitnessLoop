// A complete stage for one example app: relay + production app in one headless browser +
// a disposable shadow copy of the app in another. Used by the demos and the browser tests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from '../../src/relay.mjs';
import { createClient } from '../../src/client.mjs';
import { generateKey, fingerprint } from '../../src/attest.mjs';
import { launchBrowser } from './browser.mjs';
import { startBank } from '../bank/server.mjs';
import { startMailer } from '../mailer/server.mjs';
import { startTodo } from '../todo/server.mjs';
import { startShop } from '../shop/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APPS = {
  bank: { start: startBank, policy: 'bank.json' },
  mailer: { start: startMailer, policy: 'mailer.json' },
  todo: { start: startTodo, policy: null },
  shop: { start: startShop, policy: null },
};

export const readPolicy = (file) => JSON.parse(fs.readFileSync(path.join(HERE, '..', 'policies', file), 'utf8'));

async function waitAgent(client, name, timeoutMs = 10000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await client.health()).agents.includes(name)) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`agent "${name}" never connected`);
}

// def: { start, profile, policy } runs an app that is not one of the examples (tests bring their own fixture pages)
export async function startStage(appName, { policy, approvalTimeoutMs = 15000, def: custom, relayOptions = {} } = {}) {
  const def = custom ?? APPS[appName];
  if (!def) throw new Error(`unknown app "${appName}" (bank, mailer, todo, shop)`);
  const profile = custom ? custom.profile : (await import(`../${appName}/profile.mjs`)).profile;
  const approverKey = generateKey();
  const relay = await createRelay({
    port: 0, profile, approvalTimeoutMs, approvers: [fingerprint(approverKey.publicKey)],
    policy: policy ?? (def.policy ? readPolicy(def.policy) : { default: 'allow', rules: [] }),
    ...relayOptions,
  });
  await relay.listen();
  const client = createClient({ port: relay.port, approverKey, token: relay.token });

  const sides = {};
  for (const name of ['default', 'shadow']) {
    const app = await def.start();
    const browser = await launchBrowser();
    await browser.navigate(`${app.origin}/?witness=1&witness_port=${relay.port}&witness_name=${name}&witness_token=${relay.token}`);
    await waitAgent(client, name);
    sides[name] = { app, browser };
  }
  return {
    appName, relay, client, prod: sides.default, shadow: sides.shadow, profile,
    world: (agent = 'default') => relay.captureWorld(agent),
    async close() {
      for (const s of Object.values(sides)) { await s.browser.close(); await s.app.close(); }
      await relay.close();
    },
  };
}
