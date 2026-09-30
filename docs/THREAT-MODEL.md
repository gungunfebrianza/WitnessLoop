# Threat model and honest limits

witnessloop upgrades the evidence standard for machine action from *observability* ("the system says
what happened") to *attested causal replay* ("a claimed action can be re-executed from a checkpoint
and shown to follow from recorded causes"). This page says exactly how far that goes.

## What is proven

| Claim | Mechanism | Detected how |
|---|---|---|
| The recorded sequence was not edited, reordered, or had events removed | per-session hash chain: `hash = sha256(prev_hash + canon(event))` | first bad `idx` reported by `verify` / `verify-bundle` |
| A payload (params, result, world snapshot) was not changed after the fact | events commit to `data_hash`; checkpoints commit to `world_hash`; blobs are content-addressed | blob no longer matches its hash |
| The record was not truncated | ed25519 seals over the chain head at every 50 events and at `session.end`; `--strict` requires the tail to be sealed | seal covers a missing event / unattested tail |
| The seal was made by a key you trust | seals carry the public key; `--trusted-key <fingerprint>` pins it. A pin also covers keys reachable through valid `key.rotate` certs (signed by an already-trusted key); a seal by any other key is rejected | untrusted signer (`test/keys.test.mjs`) |
| A key that was revoked does not vouch for what came after | `key.revoke` chain events; a seal whose head is after the revoke event is rejected, earlier ones stand | `seal signed by a key revoked at event #N` (`test/keys.test.mjs`) |
| The whole history was not rewritten and resealed with the same key | `anchor` copies a seal head hash outside the ledger; `verify --anchor <file>` requires the chain to still contain that head with that hash | `history differs from the anchored seal` / `truncated relative to the anchor`; plain `verify` passes the same forgery (`test/anchor.test.mjs`) |
| A person released an irreversible action, not just something that typed a name | approvals are signed by a registered approver key over `{approval id, verdict, nonce}`; the second `decision` records the key fingerprint, signature and nonce; `--trusted-approver <fingerprint>` makes `verify` require it | unsigned, unregistered-key, wrong-verdict, replayed-nonce approvals are refused; a forged or unsigned decision fails `verify` under a pin (`test/approvers.test.mjs`) |
| Only the holder of the relay token can drive the relay | every route and the agent WebSocket require a bearer token; constant-time compare | 401 on missing or wrong token for every route (`test/auth.test.mjs`) |
| A fork really branched from the recorded past | `fork.start` stores the parent head hash and the restored world hash; `verify` re-checks the anchor | fork anchor mismatch |
| The proof preceded the consequence | `intent` and `decision` events are appended before dispatch; ledger failure aborts dispatch | event order in the chain; tested with an injected ledger failure |
| A released state-changing dispatch (irreversible or reversible) always leaves a record | a `command.begin` is appended before the click; the result event references it; a begin with no result is an *unresolved dispatch* (warning by default, error under `--strict` and for `verify-bundle`); if the begin cannot be written, nothing is dispatched | injected failure after the click is reported by `verify` (`test/gate-relay.test.mjs`) |
| A network write a click made under a `reversible` or unannotated label is on the record (after the fact) | the in-page observer reports non-GET `fetch`, XHR, `sendBeacon` and un-intercepted form submits during a click as `observed_effects` (method, origin, path, body hash only); the relay writes a `flag` (`undeclared_effect`) with that evidence and what the page declared | flag written for unannotated and explicit-`reversible` clicks, none for declared `irreversible` or GET-only; nothing but the four fields reaches the ledger (`test/observed.test.mjs`; real page: shop story in `test/e2e-browser.test.mjs`) |
| A reversible click whose server-side state changed is found again offline (heuristic) | `detect` / the report diff the app-server state (adapter) between the checkpoints around each reversible click | detected; page-only storage changes are not; a click that cannot be checked is listed as skipped, never as clean (`test/detect.test.mjs`) |
| A policy that can never fire, or a `matches` that can stall the relay, is caught | `policy --dry-run` warns on shadowed rules (only when provable) and on backtracking-prone patterns; `matches` runs under a pattern-size, input-size and time cap and falls back to `require_approval` (or `deny` under a deny-by-default policy) instead of hanging or silently not matching | `test/policy.test.mjs` |
| A profile's effect check cannot pass because it could not compute | `src/effects.mjs` building blocks return `ok:false` on a throw or a non-finite number; the bank and mailer profiles are built on them and return exactly what the hand-written versions did | `test/effects.test.mjs` (old and new compared over fixtures) |
| A session reproduces | `replay-verify` restores the genesis checkpoint on a shadow app, re-runs every step, compares normalised step results and final world hash | first divergence reported |

## What is NOT proven

1. **Key custody and the key holder.** The signing key lives in `.witnessloop/key.json`, readable by
   the same OS user that runs the relay. Whoever holds it can rewrite a whole history and reseal it, and
   plain `verify` will pass. `anchor` closes that only if the anchor sink is outside the key holder's
   control: a file sink on the same machine protects nothing against someone with that machine, and
   nothing forces anyone to anchor or to pass `--anchor` when verifying. Anchors bind a seal that existed
   when it was anchored; history written and sealed only after the last anchor is not covered.
   Rotation: trust follows valid certs from a pinned key, so pin the key you trusted *before* a rotation.
   A revocation only bites in chains that contain the `key.revoke` event (every session active at the
   time gets one); a thief with an old key can still rewrite a session that ended before the revocation,
   and only an anchor detects that. A key file that exists but is corrupt or incomplete now stops the
   start with an error and is left untouched (only a missing file creates a key; `test/keys.test.mjs`).
   The dashboard shows anchor status per session when the relay was started with `--anchor-sink`
   (`test/anchor.test.mjs`); an anchor file on the same machine still protects nothing against its holder. `rotate-key` and `revoke-key` are ordinary op-table actions,
   so they are available to anyone holding the relay token, MCP included.
2. **Annotations are the page's word; undeclared effects are detected, not prevented.** The gate acts on
   `data-wl-effect`. An unannotated button that charges a card is still classified `reversible` and runs
   without anyone being asked: nothing in Phase 2 blocks it. What exists now, and when it fires:
   - **After dispatch, live (a `flag` in the chain):** during a `dom.click` the in-page agent records
     non-GET requests made through `fetch`, `XMLHttpRequest`, `navigator.sendBeacon` and form submits the
     page did not intercept. The relay flags any of them under a click that was not declared `irreversible`
     (annotated `reversible`, or not annotated at all). The request has already left when the flag is written.
     A native form submit that navigates away is pushed over the link before unload, so it is kept even though
     the click's own reply is lost. Only method, origin, path and a body hash are stored; the hash of a
     low-entropy body (a short password) can be guessed offline, and it is `null` in an insecure context.
   - **After the fact, offline:** `detect` and the report's "Detected after the fact" section find reversible
     clicks whose app-server state changed between the surrounding checkpoints (needs the adapter and
     `--checkpoints mutating`), or which carry a recorded non-GET request. This is a heuristic; it says
     "consistent with an external effect", not "was one".
   - **Before, static, advisory:** `lint-page` lists forms, buttons and links that look like they change
     something and carry no annotation. Candidates, not verdicts.
   - **Effect checks:** the `effectCheck` hook (preview vs actual world diff) still defends against a page
     whose preview lies; `src/effects.mjs` gives the common checks, but you still choose them per app.

   Still NOT caught: any prevention of an undeclared effect; requests made after the click has settled
   (timers, polling, a response that triggers a later write); `WebSocket.send`; a page that captured
   `fetch` before the agent loaded or that talks to the network through a worker or another frame; GET
   requests with side effects (the observer ignores GET/HEAD/OPTIONS); effects not tied to a click (a
   `dom.fill` that triggers a save); server-side effects the adapter does not expose; page-storage changes
   (that is what `reversible` means); a page that omits the annotation *and* hides the request from every
   mechanism above; and JavaScript-wired buttons or script-built forms in `lint-page`. An unrecognised
   annotation value fails closed (irreversible); a missing one cannot be told from "reversible" at the gate.
   `lint-page` fetches only loopback URLs unless the person running it sets
   `WITNESSLOOP_LINT_ALLOW_REMOTE=1`, because it is also an MCP action.
3. **Approvers and relay access.** Approvals are only as trustworthy as the approver key. The key file is
   readable by the same OS user as the agent unless you keep it elsewhere; `approve` and `deny` are MCP
   actions too, so an agent that can read an approver key file (or is handed one) can approve its own actions.
   Keep approver keys out of the agent's process and reach. Without `--trusted-approver`, `verify` does not
   require signed approvals at all, and `--allow-unsigned-approvals` (off by default) restores the old
   self-declared `by` string. Relay authentication is a single shared bearer token: it identifies "a client
   that knows the token", not a person; it is written to `.witnessloop/token` (mode 0600, or icacls to the
   current user on Windows; `serve` refuses to start if that fails) and is readable by any process running as
   that user. The relay serves only loopback `Host` names (421 otherwise, defeating DNS rebinding) and refuses HTTP
   requests whose `Origin` is not the relay itself (403, even with a valid token; `test/auth.test.mjs`).
   The agent WebSocket is not Origin-checked, because the app page's origin is legitimately different: the
   token guards it. The relay is still localhost-only and not TLS. The agent link takes the token as a
   query parameter and the in-page agent keeps it in `sessionStorage`, where any script on the app page can
   read it. The dashboard page itself is served without the token and carries no data; the token is passed in
   the URL fragment and cleared from the address bar after it is read.

4. **Effects that were dispatched but not recorded.** `command.begin` is written before every
   state-changing command (irreversible and reversible; `dom.click`, `dom.fill`, `page.reload`), so a crash between
   the dispatch and its result is *detected* (unresolved dispatch), not prevented: the effect may exist, and the
   result of it is not on the chain. Reads have no write-ahead record (they change nothing) and are appended
   after dispatch. A begin appended by a compromised relay proves nothing; this is
   evidence for an honest relay that crashed, not against a dishonest one.
5. **Replay fidelity.** `replay-verify` proves reproducibility *in a shadow copy*, under app-declared
   `volatileKeys`. It does not re-run against production, and cannot reproduce effects that depend on the
   outside world (third-party APIs, real email). Nondeterministic apps will report a divergence, which is
   the honest answer.
6. **World coverage.** A checkpoint is localStorage + IndexedDB + the app server state you expose through
   the adapter. Cookies, sessionStorage, service workers, and external systems are not captured. IndexedDB
   `autoIncrement` key generators cannot be rewound, so a restored store can assign different keys; the
   agent warns in the `world.restore` reply.
7. **Causal edges.** `retry_of`, `decided`, `released`, `state_after`, `flagged` are recorded structure.
   `derived_from` (a written value first seen in an earlier read) and `observes` are heuristics, marked
   `inferred: true`, and must not be quoted as proof of influence.
8. **Bisect** evaluates an app-defined invariant on stored checkpoints; `--search binary` assumes breakage
   is monotone. It finds the first *recorded* state that fails, not a root cause in code.
9. **No `eval`, no arbitrary script.** By design; but `dom.click`/`dom.fill` can still drive any UI the
   page exposes, which is exactly why the gate exists.
10. **Policy evaluation limits.** `matches` patterns are capped (200 characters, 2000 characters of input,
    250 ms wall clock, retried once at 1 s). The time cap is wall-clock, so a machine stalled twice in a row can
    turn a harmless pattern into a limit hit, and a real blowup holds the relay for about 1.25 s per evaluation;
    the verdict then falls to `require_approval` (`deny` under a deny-by-default policy), which is
    safe but not deterministic under load. Shadowed-rule and regex-risk warnings are conservative: they miss
    shadowing that is not provable from the two conditions and may warn on a pattern that is in fact fine.
    `policy --dry-run` re-runs the policy verdict only, it does not re-ask a human.
