// A stage definition for a fixture page under test/fixtures/<name>: the page is served with the in-page agent and no server-side adapter.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAppServer } from '../../examples/lib/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const fixtureApp = (name, profile = {}, { api, adapter } = {}) => ({
  start: () => startAppServer({ publicDir: path.join(HERE, '..', 'fixtures', name), api, adapter }),
  profile: { name, volatileKeys: [], ...profile },
  policy: null,
});
