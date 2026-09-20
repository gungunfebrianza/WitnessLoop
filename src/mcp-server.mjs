#!/usr/bin/env node
// Hand-rolled MCP server over stdio (newline-delimited JSON-RPC). One tool, `witnessloop`, whose
// `action` is any op from ops.mjs: the same table the CLI uses, so the two cannot drift.
//   claude mcp add --transport stdio witnessloop -- node src/mcp-server.mjs
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mcpOps, mcpName, findOp } from './ops.mjs';
import { createClient } from './client.mjs';

export const SERVER_VERSION = '0.1.0';

export function toolDefinition() {
  const ops = mcpOps();
  return {
    name: 'witnessloop',
    description: 'Accountable autonomy for browser agents. Every action is recorded on a hash-chained, signed ledger; irreversible clicks are gated (intent, policy or human decision, then release); sessions can be forked into a shadow app, replayed and bisected. Actions: '
      + ops.map((o) => `${mcpName(o)} - ${o.desc}`).join(' | '),
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ops.map(mcpName) },
        params: { type: 'object', description: 'Arguments for the action, named as the CLI flags (camelCase): e.g. { "id": 3, "shadow": "shadow" }.' },
      },
      required: ['action'],
    },
  };
}

export async function callTool(args, client = createClient()) {
  const op = findOp(String(args?.action));
  if (!op || op.cli) throw new Error(`unknown action "${args?.action}". Actions: ${mcpOps().map(mcpName).join(', ')}`);
  const out = await op.run(client, args.params ?? {});
  return typeof out === 'string' ? out : JSON.stringify(out, null, 2);
}

export async function handle(msg, client) {
  switch (msg.method) {
    case 'initialize':
      return { protocolVersion: msg.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'witnessloop', version: SERVER_VERSION } };
    case 'ping': return {};
    case 'tools/list': return { tools: [toolDefinition()] };
    case 'tools/call': {
      try {
        if (msg.params?.name !== 'witnessloop') throw new Error(`unknown tool "${msg.params?.name}"`);
        return { content: [{ type: 'text', text: await callTool(msg.params.arguments, client) }] };
      } catch (e) {
        return { content: [{ type: 'text', text: e.message }], isError: true };
      }
    }
    default: return undefined;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const client = createClient();
  const rl = readline.createInterface({ input: process.stdin });
  const reply = (id, result, error) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }) + '\n');
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return reply(null, undefined, { code: -32700, message: 'parse error' }); }
    if (msg.id === undefined) return; // notification
    const result = await handle(msg, client);
    if (result === undefined) reply(msg.id, undefined, { code: -32601, message: `method not found: ${msg.method}` });
    else reply(msg.id, result);
  });
}
