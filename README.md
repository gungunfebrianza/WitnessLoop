# witnessloop

**Accountable autonomy for browser agents.** An agent does real, logged-in, consequential work in
a web app, and you can *prove* what it did, *fork* the past, and *re-run* the future.

Zero dependencies. Node 24+. A lean re-implementation of the core of
[web-scout](../agent-os/tools/web-scout) (WS relay + in-page agent) plus the four things it did not have:

| Gap in a plain instrumented agent | witnessloop |
|---|---|
| A log says what the system *claims* happened | **Attested ledger**: hash-chained per session, payloads content-addressed, ed25519-sealed. Any edit, deletion, reorder or truncation is caught at the exact event, offline, from an exported bundle |
| Irreversible effects run, then get logged | **Two-phase gate**: `intent` -> policy verdict -> (human approval) -> only then dispatch. If the ledger cannot record the decision, nothing is dispatched (fail closed) |
| "What if?" is a story, not a fact | **Forks**: restore a recorded world checkpoint into a *shadow* copy of the app, re-run with a param changed, a step skipped, or a different policy, and compare |
| "It reproduces" is an assertion | **replay-verify**: re-run a whole session unchanged on the shadow; reproduced only if every step result and the final world match. Every difference is labelled `volatile` / `nondeterministic` / `external` / `unknown` with its evidence |
| Failures are incidents to argue about | **bisect**: first recorded event after which an app invariant broke, who approved it, what changed, and its causes (recorded vs *inferred* edges kept apart) |

## See it work (needs any Chromium / Edge / Chrome)

```bash
npm test                 # 202 tests: ledger tamper cases, gate, anchors, keys, approvers, auth, fork/replay, CLI/MCP, real-browser e2e
npm run demo:bank        # planted rounding bug loses a cent; witnessloop finds it, forks a fix, proves it
npm run demo:mailer      # a page that BCCs an outsider; the gate flags it, the wrong recipient is refused
npm run demo:todo        # no irreversible effects: exact replay of pure IndexedDB state
npm run demo:shop        # an unannotated Pay button: not stopped, but flagged live and detected offline (after the fact)
node examples/agents/demo.mjs bank --hold   # keep everything running and open the dashboard on the result (also mailer, todo, shop)
```

`demo:bank` prints, from a real headless browser:

```
2. Ledger chain verified: true (65 events, sealed through #64).
3. bisect: first bad event is #23 ({"amount":"33.33","memo":"","to":"carol"}) - money not conserved: total 174999 != 175000 (-1 cents); approved by policy.
4. fork onto the SHADOW app under a patched boundary: 2 step(s) refused; production untouched.
   production total 174998 vs shadow total 175000 (must be 175000).
6. exported bundle verifies offline: true; flipping one payload byte at event #2 is caught: true.
```

## Use it on your own app

1. Run the relay: `node src/cli.mjs serve --profile examples/bank/profile.mjs --policy examples/policies/bank.json`
2. Add the agent to your page and mark consequences:
   ```html
   <script src="/witnessloop/inject.js"></script>   <!-- serve src/agent/inject.js at that path -->
   <button id="send" data-wl-effect="irreversible" data-wl-preview="#transfer">Send</button>
   ```
   Open the page with `?witness=1` (add `&witness_name=shadow` for a disposable copy).
   An unrecognised `data-wl-effect` value is treated as irreversible.
3. If your server holds state, mount `handleWitnessRequest` from `src/adapter.mjs`
   (`GET /__witness/state`, `POST /__witness/restore`) and add `<meta name="witness-adapter" content="1">`.
   Page state (localStorage, IndexedDB) is captured automatically.
4. Optional `--profile`: `{ volatileKeys, invariant(world), effectCheck({preview,before,after}) }`.
5. Drive it from the CLI, MCP (`claude mcp add --transport stdio witnessloop -- node src/mcp-server.mjs`) or `src/client.mjs`.

## Dashboard

`node src/cli.mjs serve ...` opens `http://127.0.0.1:8974/dashboard` (same port as the relay) in your default browser when started from an interactive terminal. Skipped with `--no-open`, `WITNESSLOOP_NO_OPEN=1`, under `CI`, or when output is piped; the URL is always printed. Read-only, no dependencies, no external requests (CSP `default-src 'none'`); ledger text is only ever rendered as text.

- **Fleet**: chain verification across all sessions, agent comparison, policy rule hit map, recorded overhead.
- **Per session**: chain health (sealed-through, unsealed tail, strict result) with a tamper demo run on a *copy* of the bundle; event timeline; decision funnel and approval latency; bisect with the invariant along the session and a state diff per checkpoint; causal graph (recorded solid, inferred dashed); fork/compare; policy what-if.
- The dashboard page is open but its data calls need the relay token: `serve` opens it as `/dashboard#token=...` (the fragment is never sent to a server and is cleared after it is read). Open it by hand with the token from `.witnessloop/token`.
- Every "verified" badge is computed by running the verifier on request, never read from a stored flag. Anchor status shows when serving with `--anchor-sink`. Not built: model/prompt metadata per agent, with/without-witnessloop latency (needs a benchmark run).

## Commands (CLI and MCP action names are the same table)

`session-start` `session-end` `cmd <type> [json]` `intents` `approve <id>` `deny <id>` `policy [file]`
`checkpoint` `verify <session> [--strict]` `verify-bundle <file>` `export <session> --out f.wl.json`
`causal` `bisect [--search linear|binary]` `fork --shadow <agent> [--at N] [--override idx.param=v] [--skip a,b] [--policy f]`
`detect <session>` `lint-page <file|url>` `policy --dry-run <session> [file]`
`replay-verify --shadow <agent>` `compare a b` `report` `serve` (`--record-nondeterminism`, `--record-external` are opt-in recording) `keygen [--role approver]` `anchor <session> [--sink f]` `rotate-key` `revoke-key <fp>`.
`verify` and `verify-bundle` also take `--anchor <file>`, `--trusted-key <fp>` and `--trusted-approver <fp>` (repeatable). Run `node src/cli.mjs --help`.

**Access and approvals.** Every relay call carries a bearer token (`serve` writes `.witnessloop/token`; clients read it or `WITNESSLOOP_TOKEN`). Approvals are signed: `keygen --role approver`, start the relay with `serve --approver <fingerprint>`, then `approve <id> --key .witnessloop/approver.json`. Unsigned approvals are refused unless `serve --allow-unsigned-approvals`. The relay serves only loopback `Host` names and refuses foreign `Origin`s. `verify` warns about *unresolved dispatches* (a state-changing command released to the page with no recorded result; the write-ahead `command.begin` is what makes it visible) and fails them under `--strict`.

**Undeclared effects.** The gate trusts `data-wl-effect`; an unannotated Pay button is not stopped. What witnessloop does about it, all *after the fact or advisory*: a click that makes a non-GET request under a `reversible`/unannotated label is flagged live (`undeclared_effect`, with method, origin, path and a body hash, never the body); `detect` and the report find reversible clicks that moved app-server state; `lint-page` lists unannotated candidates. Try `node examples/agents/demo.mjs shop`. Details and what is still missed: THREAT-MODEL limitation 2.

`policy --dry-run <session> [file|json]` prints what a policy would have decided for every recorded intent (changing nothing) with shadowed-rule and backtracking-regex warnings.

Page commands: `ping page.info dom.query dom.describe dom.text dom.wait dom.click dom.fill page.reload`.
There is deliberately **no `eval`**: an unbounded write cannot be classified, so it cannot be gated.

## What it does not claim (read [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md))

- The signing key is local. Sealing gives tamper *evidence* against later edits, not against whoever holds the key; `anchor` helps only if the sink is outside the key holder's control.
- The gate is only as good as the page's `data-wl-effect` annotations. The relay token and approver keys are files readable by the same OS user; approver keys must be kept away from the agent.
- Replay is scoped to a shadow environment. Clock and randomness replay exactly only if production ran with `serve --record-nondeterminism` (values drawn during clicks and fills; the agent must be the first script on the page); third-party `fetch` responses replay from a recording only for origins named with `serve --record-external <origin>`. Everything else that differs is reported and classified, not hidden. See `docs/THREAT-MODEL.md`.
- A checkpoint holds localStorage, sessionStorage, `document.cookie`, service-worker registrations, IndexedDB and adapter state, and says on the record what it cannot hold (HttpOnly cookies, worker caches, live connections). `redactKeys` in the profile keeps named values out of snapshots and bundles; command params and results are not redacted.
- IndexedDB cannot rewind `autoIncrement` key generators: the drift is measured after a restore and reported (and classified when it causes a difference); use explicit ids in apps you want to replay exactly.
- Causal `derived_from` and `observes` edges are heuristics, always labelled *inferred*. `value_flow` is a recorded observation by the page agent that a value it served came back exactly in a later fill: not proof of cause.

## Layout

`src/` ledger, attest, gate, policy, effects, detect, lint, world, causal, bisect, replay, relay, cli, mcp-server, agent/inject.js
· `examples/` bank, mailer, todo, shop (+ profiles, policies, scripted agents, stories) · `test/` · `docs/DESIGN.md`
