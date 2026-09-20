// Todo list: state lives ONLY in the browser (IndexedDB), and nothing is irreversible. It is the
// control case: the gate never fires, checkpoints capture pure page state, replay is exact.
// Run standalone: node examples/todo/server.mjs [port]   then open  http://127.0.0.1:<port>/?witness=1
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startAppServer } from '../lib/server.mjs';

export async function startTodo({ port = 0 } = {}) {
  return startAppServer({ publicDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'public'), port });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await startTodo({ port: Number(process.argv[2]) || 3103 });
  console.log(`Todo on ${app.origin}/?witness=1`);
}
