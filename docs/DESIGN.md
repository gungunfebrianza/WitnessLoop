# Design

## Shape

```
 caller (CLI / MCP / script)                       browser page (production)      browser page (shadow)
        | HTTP {ok,result}                               ^ WS  command/reply             ^ WS
        v                                                |                              |
   +-----------------------------------  relay  ------------------------------------------+
   |  auth: loopback Host, Origin, bearer token (auth.mjs) on every route and the agent link   |
   |  runCommand: classify -> [gate] -> command.begin -> dispatch -> command -> checkpoint     |
   |              -> effectCheck / undeclared-effect flag                                      |
   |  gate.mjs / policy.mjs      ledger.mjs (sqlite, hash chain, seals)      world.mjs          |
   |  attest.mjs / anchor.mjs    causal / bisect / replay / report / detect / lint / effects   |
   +-------------------------------------------------------------------------------------------+
                    app server state <-- GET/POST /__witness/state|restore (adapter.mjs)
```

Borrowed from web-scout (design, not code): hand-rolled WS on `http` upgrade, `{kind:'command'|'reply'}`
envelopes with a pending-map and timeouts, an in-page agent dormant unless opted in, a command registry
with an "every handler is classified" test, `connectFakeAgent` for browserless tests, raw-CDP browser harness,
hand-rolled stdio MCP. Left out: token shaping, read cache, savings analytics, dashboard, `eval`.

## Event model

One chain per session (`prev_hash` links events of the same session; genesis is 64 zeros), so a session
exports as a self-contained bundle. Kinds:

| kind | written when | data |
|---|---|---|
| `session.start` | session opens | goal, actor, agent, parent |
| `checkpoint` | genesis, after every state-changing command, manual | `{label, after_idx, world_hash, state_hash}` (world blob travels with the bundle) |
| `intent` | before an irreversible click | params, page `describe` (effect, `declared`, label), `preview` (form fields) |
| `decision` | policy verdict, then human resolution if `require_approval` | `{intent_idx, verdict, rule, reason, by, resolves_idx}`; a human decision adds `approver_fp, approver_pub, sig, nonce` and its `actor` is `approver:<fp>` |
| `command.begin` | write-ahead, before every state-changing dispatch (irreversible and reversible; not reads) | `{params, intent_idx?}` |
| `command` | after dispatch | `{params, result, error, intent_idx?, begin_idx?, describe?, observed_effects?, ms}`; `ok` column. A begin with no `command` pointing back at it is an *unresolved dispatch* |
| `flag` | `effect_mismatch`: `effectCheck` says the actual effect differs from the preview. `undeclared_effect`: a non-GET request during a click that was not declared irreversible | `{command_idx, why, evidence}`; the latter's evidence is method, origin, path, body hash only |
| `key.rotate` / `key.revoke` | a signing key is replaced / declared untrusted | the rotation cert `{old_pub,new_pub,ts,sig}` / `{fingerprint, ts, sig}` |
| `fork.start` | first event of a fork | parent session, parent head idx+hash, checkpoint, override, skip |
| `session.end` | session closes | summary counts; followed by a seal |

## Gate

`dom.click` is `dynamic`: the page's own annotation decides the class (`read` is not allowed for a click).
Only `irreversible` goes through `gate()`: append `intent`, evaluate policy, append `decision`; if
`require_approval`, wait on the `Approvals` queue (`POST /gate/:id/approve|deny`; timeout = deny), then append a
second `decision`. The click is dispatched only after an `allow`. Forks auto-approve (a shadow copy has nothing to protect) but deny still denies.

Approvals are signed: each pending approval carries a one-time nonce, and the approver signs `{id, verdict, nonce}` with a registered approver key (`serve --approver <fp>`). Unsigned, unregistered, wrong-verdict and replayed approvals are refused and leave the approval pending. `verify --trusted-approver` makes the verifier require that signature on released human decisions. After the gate, `runCommand` appends `command.begin`, dispatches, then appends `command`; a failure to write the begin means nothing is dispatched.

`policy.mjs` runs `matches` under pattern, input and time caps and falls back to `require_approval` (never a silent no-match). `lintPolicy` warns on provably shadowed rules and backtracking-prone patterns; `policy --dry-run <session>` replays recorded intents through a policy without recording anything.

## Checkpoints, forks, replay

`world = { page:{localStorage, sessionStorage, cookies, serviceWorkers, indexedDB, url, meta}, server }`. `stateHash` compares
the stores and the server state (not the url, not `volatileKeys`). The relay writes every snapshot through one function that
applies `profile.redactKeys` and records `coverage` (captured, `notCaptured`, redacted count) on the checkpoint event, so what a
checkpoint cannot hold is stated on the record. An autoIncrement store's next key is read by an aborted probe transaction (an abort rewinds the generator). Fork at event N: take the last checkpoint before N, `restoreWorld` on the
shadow agent (server via adapter, page via `world.restore` then reload), open a child session, record
`fork.start`, then re-execute every recorded `command` at or after N through the normal pipeline
(`runCommand`), so the fork is itself gated, checkpointed and verifiable. Refused (denied) intents are
never replayed because they never ran. `compare` aligns *attempts* (commands, plus intents that were refused).

**What a replay controls, and what it reports** (Phase 3). Before the restore (which reloads the shadow page) the fork arms the shadow:

- `shim.arm` installs a seeded `Math.random`, a virtual `Date` (a `Proxy`, so statics and `instanceof` work) and remembers the arming in the tab's sessionStorage, so the copy of the agent that runs first on the reloaded page installs them before app scripts. The seed is the parent's `session.start` hash; both seed and mode are written to `fork.start`.
- If production ran with `--record-nondeterminism`, each click and fill result carries `nondet` (the values drawn during that command). The fork feeds them back per command (`shim.feed`); the shadow reports what it drew and was fed. A draw with nothing recorded falls back to the seeded generator and is evidence of nondeterminism, never silently absorbed.
- If production ran with `--record-external <origin>`, each command records the named origins' `fetch` responses as blobs the command commits to; the fork switches the shadow to serve them (`external.arm` replay, `external.feed`). No match means the fetch fails; XHR and beacon to those origins are blocked. If the switch cannot be made the fork is refused.
- `classify.mjs` then labels every difference (`volatile` / `nondeterministic` / `external` / `unknown`) with evidence. `reproduced` is true only when every difference is inside a declared volatile key.

**Why recorded draws, not just seeded shims.** A seeded clock makes two replays equal each other, but not equal to a production run that read the wall clock; `replay-verify` compares against the recording. So the recording is the mechanism and the seed is the fallback.

**IndexedDB autoIncrement: detect, not rewind.** The generator can only be reset by deleting and recreating the store, which bumps the database version and makes any app that opens a fixed version fail. A restore that would break the page it restores is worse than a reported drift, so the drift is measured after the restore and classified.

## Causality

Edges are `{cause, effect, kind, inferred}`. Recorded structure (`decided`, `resolved_by`, `released`, `state_after`, `flagged`, `retry_of`, `verifies`) is written by the relay. Two heuristics stay permanently inferred: `derived_from` (a written value first appeared in an earlier read, substring match, any page load) and `observes` (a read right after a write). They can be wrong in both directions and cannot be made sound from the outside, because whether a value influenced a decision lives in the caller (the model), which witnessloop does not see.

One case the page agent can see directly: it returned a string in a read, and later a fill typed exactly that string, in the same page load. That is recorded as a separate edge kind, `value_flow` (`inferred: false`), from a per-load reply counter the agent puts on read and fill results. It is an *observed equality*, reported by an untrusted page: it shows the value was available and came back, not that the read caused the fill (a coincidence, or a value the caller already had, looks the same). Rules that keep the families apart: a heuristic edge is never promoted (a pair found by both keeps a `derived_from` with `inferred: true` and gets a separate `value_flow`); a pair found only by the heuristic gets no `value_flow`; a report with an unknown seq, another page load, a later read or malformed fields adds nothing. Click-driven flows have no recorded edge: a click carries no value the agent can match. The decision, then: keep the heuristics inferred for good, add the one recorded kind where the agent can observe it, and never let either be quoted as proof.

## Trust: seals, anchors, keys, access

Seals are ed25519 over the chain head every 50 events and at `session.end`. Three things sit around them:

- **Anchors** (`anchor.mjs`): a seal head hash copied outside the ledger (file sink, or a pluggable async function). `verify --anchor` fails closed if there is no anchor for the session or the chain no longer contains that head with that hash. The dashboard shows the same status per session. Only meaningful if the sink is outside the key holder's control.
- **Key rotation** (`attest.mjs`, `ledger.mjs`): `rotate-key` writes a cert signed by the old key, stored in a `rotations` table, carried in bundles, and recorded as `key.rotate` in every active session. A verifier pinned to a key trusts the closure of valid certs from it; a seal by any other key is rejected. `key.revoke` removes trust for seals whose head comes after the revoke event. A corrupt key file stops the start; only a missing one creates a key.
- **Relay access** (`auth.mjs`, `relay.mjs`): only loopback `Host` names are served (421 otherwise), HTTP requests with a foreign `Origin` get 403, and every route plus the agent WebSocket needs a bearer token (32 random bytes, constant-time compare, written by `serve` to a user-only file; `serve` refuses to start if it cannot restrict the file). Only the static dashboard page is open; it takes the token from the URL fragment.

## Detecting what the gate cannot see

The gate trusts the page's `data-wl-effect`. Everything here is detection or advice, never prevention:

- **Observer** (`agent/inject.js`): during a `dom.click` it records non-GET `fetch`, XHR, `sendBeacon` and un-intercepted form submits as `observed_effects` (method, origin, path, body hash). The relay flags them under a click not declared irreversible. A native submit that unloads the page is pushed over the link first so it survives a lost reply. The agent connects only after the page's load event and startup fetches have settled.
- **Detector** (`detect.mjs`): offline, compares app-server state across the checkpoints around each reversible click and reports changes as "detected after the fact". Clicks it cannot check are listed as skipped, never as clean.
- **Linter** (`lint.mjs`): static scan of a page for unannotated forms, buttons and links; candidates only, loopback URLs only unless the operator opts in through the environment.
- **Effect checks** (`effects.mjs`): reusable `effectCheck`/`invariant` building blocks (`conserved`, `deltaEquals`, `noExtraMembers`, `sameMembers`, `noExtraFields`, `forbid`, `allOf`) that return `ok:false` when they cannot compute. The bank and mailer profiles are built on them.

## Testing strategy

- `ledger.test`: every tamper class (field edit, blob edit, delete, swap, truncate, forged/foreign seal, recompute-all-hashes).
- `gate-relay.test`: ordering, denial leaves no command, timeout, fail-closed via injected ledger failure, effect mismatch, over a real WS with a fake page.
- `analysis.test`: bisect (linear = binary, fewer evaluations), fork under patched policy, override, shadow-only refusal, replay-verify positive and negative, causal kinds.
- `cli-mcp.test`: one op table, parity, offline verify with a tampered bundle, unreachable-relay message.
- `e2e-browser.test`: the four stories (bank, mailer, todo, shop) in a real headless browser, plus the fail-closed annotation check, a static drift check between `registry.mjs` and `inject.js`, and the connect-after-settle check.
- `anchor`, `keys`, `approvers`, `auth`: each Phase 1 guarantee with its tamper and failure cases (rewrite-and-reseal, forged cert, revoked-key seal, replayed nonce, missing token, foreign Host and Origin, corrupt key file).
- `observed`, `detect`, `lint`, `effects`, `policy`: Phase 2. `effects.test` keeps the pre-refactor profile functions as the reference for "output unchanged".
- `redact`, `world-stores`, `shims`, `shims-browser`, `external`, `classify`, `replay-classes`, `value-flow`: Phase 3. Each has its control case (the same run without the feature, which must fail or differ): secrets present without `redactKeys`, a seeded clock that does not reproduce a wall-clock run, a live provider that answers differently.
- Browser tests are CPU heavy; `npm test` runs test files one at a time. At the default concurrency on an 8-core machine the extra browser files produced timeouts (a different one each run) that vanish when files run one at a time.
