#!/usr/bin/env node
// node examples/agents/demo.mjs <bank|mailer|todo>
// Starts a relay, the example app twice (production + a disposable shadow copy, each in its own
// headless browser), runs the story for that app, and narrates what witnessloop proves.
import { startStage } from '../lib/stage.mjs';
import { findBrowser } from '../lib/browser.mjs';
import { stories } from './stories.mjs';

const app = process.argv[2];
if (!stories[app]) { console.error('usage: node examples/agents/demo.mjs <bank|mailer|todo>'); process.exit(2); }
if (!findBrowser()) { console.error('No Chromium/Edge/Chrome found. Install one or set WITNESSLOOP_BROWSER=<path>.'); process.exit(2); }

const stage = await startStage(app);
try {
  console.log(`\n=== witnessloop demo: ${app} ===\n`);
  const r = await stories[app].story(stage, (line) => console.log(line));
  console.log(`\nbundle written to ${r.proof.file}\nverify it anywhere:  node src/cli.mjs verify-bundle "${r.proof.file}"\n`);
} finally {
  await stage.close();
}
