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
| The seal was made by a key you trust | seals carry the public key; `--trusted-key <fingerprint>` pins it | untrusted signer |
| A fork really branched from the recorded past | `fork.start` stores the parent head hash and the restored world hash; `verify` re-checks the anchor | fork anchor mismatch |
| The proof preceded the consequence | `intent` and `decision` events are appended before dispatch; ledger failure aborts dispatch | event order in the chain; tested with an injected ledger failure |
| A session reproduces | `replay-verify` restores the genesis checkpoint on a shadow app, re-runs every step, compares normalised step results and final world hash | first divergence reported |

## What is NOT proven

1. **Key custody.** The signing key lives in `.witnessloop/key.json`. Someone who holds it can rewrite a
   whole history and reseal it. Seals give tamper evidence against later edits by anyone *without* the key.
   If you need more, publish a seal's `head_hash` (it is in every exported bundle) to something the key holder cannot rewrite.
2. **Annotations are the page's word.** The gate acts on `data-wl-effect`. An unannotated button that
   actually charges a card is treated as reversible. An unrecognised value fails closed (irreversible), but
   a missing annotation cannot be detected. The `effectCheck` hook (preview vs actual world diff) is the
   defence against a page whose preview lies; you must write it per app.
3. **The relay is unauthenticated.** It binds 127.0.0.1 only, but any local process can call `approve`.
   `--by` is a self-declared name, not an identity. Do not treat approvals as authenticated human sign-off
   without putting real authentication in front of the relay.
4. **Ledger append failure after dispatch.** Fail-closed covers `intent` and `decision`. If the *command
   result* cannot be recorded after the click already happened, the effect exists without its result event.
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
