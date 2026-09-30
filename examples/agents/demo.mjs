#!/usr/bin/env node
// node examples/agents/demo.mjs <bank|mailer|todo> [--hold] [--no-open]
// --hold keeps the relay and both apps running after the story so the dashboard can be explored (Ctrl+C to stop).
// Starts a relay, the example app twice (production + a disposable shadow copy, each in its own
// headless browser), runs the story for that app, and narrates what witnessloop proves.
import { startStage } from '../lib/stage.mjs';
import { findBrowser } from '../lib/browser.mjs';
import { stories } from './stories.mjs';
import { openUrl, shouldOpen } from '../../src/open.mjs';

const app = process.argv[2];
const hold = process.argv.includes('--hold');
const noOpen = process.argv.includes('--no-open');
if (!stories[app]) { console.error('usage: node examples/agents/demo.mjs <bank|mailer|todo> [--hold] [--no-open]'); process.exit(2); }
if (!findBrowser()) { console.error('No Chromium/Edge/Chrome found. Install one or set WITNESSLOOP_BROWSER=<path>.'); process.exit(2); }

const stage = await startStage(app);
try {
  console.log(`\n=== witnessloop demo: ${app} ===\n`);
  const r = await stories[app].story(stage, (line) => console.log(line));
  console.log(`\nbundle written to ${r.proof.file}\nverify it anywhere:  node src/cli.mjs verify-bundle "${r.proof.file}"\n`);
  if (hold) {
    const url = `http://127.0.0.1:${stage.relay.port}/dashboard`;
    console.log(`dashboard (relay kept running, Ctrl+C to stop): ${url}`);
    if (shouldOpen({ noOpen })) openUrl(url);
    await new Promise((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  }
} finally {
  await stage.close();
}
