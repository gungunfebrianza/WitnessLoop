# Design

## Shape

```
 caller (CLI / MCP / script)                       browser page (production)      browser page (shadow)
        | HTTP {ok,result}                               ^ WS  command/reply             ^ WS
        v                                                |                              |
   +-----------------------------------  relay  ------------------------------------------+
   |  runCommand: classify -> [gate] -> dispatch -> ledger.append -> checkpoint -> effectCheck |
   |  gate.mjs / policy.mjs      ledger.mjs (sqlite, hash chain, seals)      world.mjs          |
   |  causal.mjs / bisect.mjs / replay.mjs / report.mjs        routes-analysis.mjs             |
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
| `intent` | before an irreversible click | params, page `describe` (effect, label), `preview` (form fields) |
| `decision` | policy verdict, then human resolution if `require_approval` | `{intent_idx, verdict, rule, reason, by, resolves_idx}` |
| `command` | after dispatch | `{params, result, error, intent_idx?, describe?, ms}`; `ok` column |
| `flag` | `effectCheck` says the actual effect differs from the preview | `{command_idx, why, evidence}` |
| `fork.start` | first event of a fork | parent session, parent head idx+hash, checkpoint, override, skip |
| `session.end` | session closes | summary counts; followed by a seal |

## Gate

`dom.click` is `dynamic`: the page's own annotation decides the class (`read` is not allowed for a click).
Only `irreversible` goes through `gate()`: append `intent`, evaluate policy, append `decision`; if
`require_approval`, wait on the `Approvals` queue (`POST /gate/:id/approve|deny`; timeout = deny), then append a
second `decision`. The click is dispatched only after an `allow`. Forks auto-approve (a shadow copy has nothing to protect) but deny still denies.

## Checkpoints, forks, replay

`world = { page:{localStorage, indexedDB, url}, server }`; `stateHash` compares only storage + server state
(not the url, not `volatileKeys`). Fork at event N: take the last checkpoint before N, `restoreWorld` on the
shadow agent (server via adapter, page via `world.restore` then reload), open a child session, record
`fork.start`, then re-execute every recorded `command` at or after N through the normal pipeline
(`runCommand`), so the fork is itself gated, checkpointed and verifiable. Refused (denied) intents are
never replayed because they never ran. `compare` aligns *attempts* (commands, plus intents that were refused).

## Testing strategy

- `ledger.test`: every tamper class (field edit, blob edit, delete, swap, truncate, forged/foreign seal, recompute-all-hashes).
- `gate-relay.test`: ordering, denial leaves no command, timeout, fail-closed via injected ledger failure, effect mismatch, over a real WS with a fake page.
- `analysis.test`: bisect (linear = binary, fewer evaluations), fork under patched policy, override, shadow-only refusal, replay-verify positive and negative, causal kinds.
- `cli-mcp.test`: one op table, parity, offline verify with a tampered bundle, unreachable-relay message.
- `e2e-browser.test`: the three stories in a real headless browser, plus the fail-closed annotation check and a static drift check between `registry.mjs` and `inject.js`.
