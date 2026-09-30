# WitnessLoop Roadmap

Covers two tracks: the **project** (engineering) and the **paper** (`paper.md`). Each project item maps to a stated limitation (`docs/THREAT-MODEL.md`, paper Section 8) or to a gap in the evaluation. Phases are ordered by how much they strengthen the provability claim, not by calendar; no dates are committed.

Status legend: **Done** shipped in the repo today. **Next** planned. **Later** wanted, not designed. **Open** research question.

---

## 0. Where we are (Done)

| Area | State |
|---|---|
| Ledger | Per-session hash chain, content-addressed blobs, ed25519 seals every 50 events and at `session.end`, `--strict` tail check, offline `verify-bundle` |
| Gate | Two-phase `intent` -> `decision` -> dispatch, fail closed on ledger error, approval queue with timeout = deny |
| Policy | Declarative JSON, first match wins, ten operators, default `require_approval` |
| Classification | `read` / `reversible` / `irreversible` / `dynamic`; unknown annotation fails closed; no `eval` |
| Analyses | Causal graph (recorded vs inferred edges), `bisect` (linear, binary), fork/counterfactual, `compare`, `replay-verify`, `report` |
| Surfaces | CLI and MCP server from one op table, in-page agent, WS relay |
| Examples | bank, mailer, todo, with profiles, policies, scripted stories |
| Tests | 52 tests including real-browser e2e (per README) |
| Docs | README, DESIGN, THREAT-MODEL, `paper.md` draft |

---

## Phase 1: Close the honest gaps in the trust story

Goal: remove the caveats a reviewer will raise first. These are the limitations that let the guarantees be bypassed or overstated.

| # | Item | Addresses | Acceptance |
|---|---|---|---|
| 1.1 | **Write-ahead result recording.** Append a `command.begin` before dispatch and reconcile a missing result on recovery, so an effect never exists without a record | Limit 4 (append failure after dispatch) | Injected failure after click leaves a detectable `begin` with no result; test asserts the gap is surfaced by `verify` |
| 1.2 | **External seal anchoring.** Publish a seal `head_hash` to something the key holder cannot rewrite (append-only file, transparency-log-style endpoint, or git tag) | Limit 1 (key custody) | `verify --anchor <source>` fails when history is rewritten and resealed with the same key |
| 1.3 | **Authenticated approvers.** Require a signed approval (per-approver ed25519 key) instead of self-declared `--by`; decision event stores approver key fingerprint | Limit 3 (unauthenticated relay) | Approval from an unknown key is rejected; bundle verify can pin approver keys |
| 1.4 | **Relay auth.** Token or Unix-socket/named-pipe binding so another local process cannot call `approve` or `policy` | Limit 3 | Unauthenticated call returns 401 in test |
| 1.5 | **Key rotation and revocation.** Multiple trusted keys, rotation event in the chain | Limit 1 | Verify across a rotation boundary |

Exit criteria: each of limits 1, 3, 4 either resolved or downgraded in `THREAT-MODEL.md`, and paper Section 8 updated to match.

---

## Phase 2: Detect what the gate cannot see

Goal: attack "annotations are the page's word" (limit 2), the weakest link in the gate.

| # | Item | Acceptance |
|---|---|---|
| 2.1 | **Unannotated-consequence detector.** Heuristics over a recorded session: a click followed by a server-state or network side effect with no `irreversible` classification produces a `flag` | Story where an unannotated "Pay" button is caught after the fact |
| 2.2 | **Network-level effect observation.** Observe non-GET requests triggered by a click and compare with the class the page declared | Mismatch is a recorded flag; a page cannot silently POST under a `reversible` label |
| 2.3 | **Annotation linter and coverage report.** Static scan of a page for forms and buttons lacking `data-wl-effect` | CLI command lists unannotated candidates |
| 2.4 | **Effect-check library.** Reusable `effectCheck` building blocks (money conserved, recipient set matches preview) so each app does not hand-write them | Bank and mailer profiles rebuilt on the library with unchanged story output |
| 2.5 | **Policy hardening.** Policy dry-run against a recorded session ("what would this policy have decided?"), rule shadowing warnings, tested regex safety for `matches` | `policy --dry-run <session>` output; ReDoS test |

Exit criteria: at least one demonstrated class of unannotated-effect a page cannot hide.

---

## Phase 3: Broader worlds and stronger replay

Goal: widen what a checkpoint captures and what replay can honestly claim (limits 5, 6).

| # | Item | Acceptance |
|---|---|---|
| 3.1 | **More world coverage.** Cookies, sessionStorage, and service-worker state in the checkpoint | Round-trip restore test per store; documented remaining gaps |
| 3.2 | **Deterministic environment shims.** Controllable clock and randomness in the shadow page | Todo-like app with `Date.now()` reproduces without `volatileKeys` |
| 3.3 | **External-dependency recording.** Record and replay HTTP responses from third-party APIs into the bundle, with clear labelling that replay used recorded, not live, responses | Mailer variant with a stubbed provider replays deterministically |
| 3.4 | **autoIncrement handling.** Resolve or automatically work around IndexedDB key-generator drift | Todo app with autoIncrement replays exactly |
| 3.5 | **Replay divergence explainer.** Classify a divergence as volatile, nondeterministic, or external | `replay-verify` output names the class |
| 3.6 | **Sound causality.** Replace heuristic `derived_from` with taint-style tracking where feasible, or keep inferred and prove no downstream use as evidence | Either a recorded edge kind with a test, or a documented decision to retain |

---

## Phase 4: Real agents and real workloads

Goal: the biggest hole in the paper's evaluation. All current results use scripted agents on small apps.

| # | Item | Acceptance |
|---|---|---|
| 4.1 | **LLM-driven agent harness.** Drive WitnessLoop from an MCP client with a real model on the example apps; record sessions | Reproducible run script; sessions verify and bisect |
| 4.2 | **Task suite.** A set of multi-step tasks per app with known-bad outcomes (wrong recipient, rounding loss, duplicate entry, over-limit payment) | Suite with ground truth per task |
| 4.3 | **Measured outcomes.** Rate of gate interventions, false-positive approvals, bisect accuracy versus ground truth, fork counterfactual success | Table of results with variance across runs |
| 4.4 | **Overhead benchmarks.** Per-command latency, ledger size per session, checkpoint cost as world size grows, seal and verify time | Benchmarks under `bench/`; numbers reported with hardware |
| 4.5 | **Adversarial evaluation.** A red-team agent that tries to evade the gate: unannotated buttons, lying previews, timing tricks, approval spam | Written findings; each successful evasion becomes a test or a documented limit |
| 4.6 | **A real third-party-style app.** At least one app not written by the authors, integrated with only annotations and an adapter | Integration effort reported honestly, including what was hard |

Exit criteria: paper Section 6 rewritten with measured data, not only demonstrations.

---

## Phase 5: Usability and ecosystem

| # | Item | Acceptance |
|---|---|---|
| 5.1 | **Reviewer UI.** Minimal local approval page showing preview, policy reason, and causal context | Human can approve or deny without the CLI |
| 5.2 | **Report polish.** Shareable, self-verifying report (HTML embedding the bundle and verifier) | Report opens offline and re-verifies |
| 5.3 | **Verifier as a standalone tool.** Tiny dependency-free verifier auditors can read and run without the rest of the project | Under a size budget; reviewed independently |
| 5.4 | **Framework adapters.** Server adapters for common stacks beyond the hand-mounted `handleWitnessRequest` | Two adapters with example apps |
| 5.5 | **Non-browser tool boundaries.** Generalise beyond the DOM: an HTTP/API tool boundary with the same intent/decision/seal model | Prototype gating a REST tool with the same ledger |
| 5.6 | **Cross-platform CI.** Run tests and browser e2e on Windows, macOS, Linux | Green matrix |

---

## Paper roadmap

The paper (`paper.md`) is a system-and-position draft. Work needed to reach a submittable state:

| Step | Task | Depends on |
|---|---|---|
| P1 | **Verify every number.** Re-run `npm test` and the three demos; replace README-copied figures with fresh output; record commit hash | none |
| P2 | **Verify references.** Check every citation, page range, and venue; add missing related work on agent audit logging, transparency logs, provenance, and safe tool-use policy (only sources actually read) | none |
| P3 | **Sharpen the claim.** State one testable thesis and the properties, G1 to G4, as checkable propositions with the mechanism and test for each | none |
| P4 | **Related-work comparison table.** Compare against tracing/observability tools, tamper-evident logs, agent guardrail frameworks, and record/replay systems along: ordering-before-effect, offline verifiability, counterfactual replay | P2 |
| P5 | **Formalise the gate.** Short precise statement of the fail-closed guarantee and its exact scope, including the post-dispatch gap | Phase 1.1 |
| P6 | **Evaluation rewrite.** Replace demonstrations with measured results from Phase 4 | Phase 4 |
| P7 | **Limitations update.** Move each resolved limit to "proven", keep unresolved ones stated | Phases 1 to 3 |
| P8 | **Figures.** Architecture diagram, event/chain diagram, gate sequence diagram, bank-story timeline | none |
| P9 | **Artifact preparation.** Pinned version, one-command reproduction, expected-output files, artifact README | Phase 4 |
| P10 | **Venue fit and formatting.** Pick venue (security, systems, or agent-safety workshop), reformat, add authors and affiliations | P3 to P8 |

### Paper milestones

1. **Draft 1 (now):** system description, three demonstration stories, honest limits.
2. **Draft 2:** numbers verified, references verified, figures, sharper claims (P1 to P4, P8).
3. **Draft 3:** Phase 1 results integrated, formal gate statement (P5, P7).
4. **Submission candidate:** measured evaluation with real agents and adversarial section (P6, P9, P10).

---

## Phase 1 status

Implemented and tested (see `docs/THREAT-MODEL.md` for exactly what each does and does not prove):

- **1.1** write-ahead `command.begin` for every state-changing dispatch (irreversible and, since a later change, reversible); `verify` reports unresolved dispatches (warning, error under `--strict`); analysis modules tolerate the new kind. Scope: irreversible commands only. Tests: `test/gate-relay.test.mjs`, `test/ledger.test.mjs`.
- **1.2** `anchor`, file sink, pluggable sink function, `verify --anchor` / `verify-bundle --anchor`. Tests: `test/anchor.test.mjs` (a full rewrite resealed with the same key passes plain verify and fails against the anchor). Only meaningful with a sink the key holder cannot rewrite.
- **1.3** approver keys (`keygen --role approver`), signed approvals over {id, verdict, nonce}, replay protection, `--trusted-approver`, `--allow-unsigned-approvals` (off by default). Tests: `test/approvers.test.mjs`.
- **1.4** bearer token on every route and the agent WebSocket, token file with restricted permissions (icacls on Windows; `serve` refuses to start if it fails), dashboard token via URL fragment. Tests: `test/auth.test.mjs`.
- **1.5** `rotate-key`, `revoke-key`, `key.rotate` / `key.revoke` chain events, rotation certs carried in bundles, verification from a pinned key across rotations. Tests: `test/keys.test.mjs`.

Still open: no external anchor service or default sink; the shared token is not a per-person identity; approver keys are files (no hardware or OS keystore); the relay has no `Origin`/`Host` check or TLS; a corrupt key file is still silently regenerated; the dashboard does not show anchor status; browser-driven tests are timing-sensitive under parallel load and occasionally fail (they also did before Phase 1).

## Phase 2 status

Implemented and tested (`docs/THREAT-MODEL.md` limitation 2 says exactly what is and is not caught, and when). Everything here is detection or advice: nothing blocks an undeclared effect.

- **2.2** the in-page agent reports non-GET `fetch`/XHR/`sendBeacon`/un-intercepted form submits during a click (`observed_effects`: method, origin, path, body hash); the relay writes an `undeclared_effect` flag under a `reversible` or unannotated click. After dispatch, never before. Tests: `test/observed.test.mjs` (relay side, fake agent), shop story in `test/e2e-browser.test.mjs` (real page).
- **2.1** `src/detect.mjs`, `detect <session>`, and a "Detected after the fact" report section (reversible clicks whose app-server state changed, or that carry a recorded write; heuristic). New `examples/shop` story with an unannotated Pay button. Tests: `test/detect.test.mjs`.
- **2.3** `lint-page <file|url>`: candidates, not verdicts; loopback URLs only unless the operator sets `WITNESSLOOP_LINT_ALLOW_REMOTE=1`. Tests: `test/lint.test.mjs`.
- **2.4** `src/effects.mjs`; bank and mailer profiles rebuilt on it, with the old functions kept in `test/effects.test.mjs` as the reference for "output unchanged". Tests: `test/effects.test.mjs`.
- **2.5** `policy --dry-run <session> [file]`, shadowed-rule and backtracking-regex warnings, a size/input/time cap on `matches` that fails to `require_approval`. Tests: `test/policy.test.mjs`.

Also changed, not on the roadmap: the in-page agent now connects only after the page's load event and its own startup fetches settle (max 5 s wait), because a fork or new session could otherwise read a half-rendered page (`test/e2e-browser.test.mjs`, "announces a page only after..."). The dashboard browser test now waits for a tab instead of sleeping 300 ms, and one Phase 1 approval test uses a longer timeout, both timing-only.

Test run at the end of Phase 2: 142 tests, 142 pass, three consecutive `npm test` runs. Earlier runs in the same session had 1 or 2 failures each (browser tests and two timing-sensitive tests under parallel load, and a Windows libuv abort when a runner force-exit raced closing sockets); those were fixed in the tests, not by loosening an assertion.

Still open: no prevention of undeclared effects (only the gate on annotated ones); the observer misses WebSocket traffic, timers after the click settles, a `fetch` saved before the agent loaded, workers and frames; the offline detector needs the adapter and `mutating` checkpoints and only sees app-server state; body hashes of low-entropy bodies can be guessed offline; `lint-page` cannot see JavaScript-wired controls; shadowing warnings only cover provable cases and `matches` limits are wall-clock (a machine stalled twice can produce a spurious limit hit, which resolves to `require_approval`).

## Phase 3 status

Implemented and tested. Replay claims are stated in `docs/THREAT-MODEL.md` limitations 5 to 7: what is held fixed, what is only reported.

- **3.1** sessionStorage, `document.cookie` and service-worker registrations captured and restored (real-browser round trip per store); every checkpoint records `coverage` including `notCaptured` (HttpOnly cookies, worker caches, ...). `profile.redactKeys` redacts where snapshots become blobs; a secret is absent from every bundle blob (control without it contains the secret). Tests: `redact`, `world-stores`.
- **3.4** autoIncrement: chose detect over rewind (rewinding needs a store recreate and version bump). The generator is read by an aborted probe; drift is written to `fork.start` and classified. Tests: `world-stores`, `replay-classes`.
- **3.2** shims: `Date`/`Math.random` shadow-only, armed before the restore reload, seed from the parent's `session.start` hash in `fork.start`. Seeded shims alone cannot equal a wall-clock production run, so `serve --record-nondeterminism` (opt-in) records draws per click/fill and the shadow replays them. Todo page with `volatileKeys: []` reproduces with a recording and does not without. Tests: `shims`, `shims-browser`.
- **3.3** `serve --record-external <origin>` (default off): fetch responses from named foreign origins become blobs the command commits to, verified in bundles; the shadow serves them, an uncovered fetch fails and XHR/beacon are blocked, a shadow that cannot switch refuses the fork; result says `replayed against recorded external responses`. Verified with the provider stopped. Test: `external`.
- **3.5** `src/classify.mjs`: each divergence is `volatile`/`nondeterministic`/`external`/`unknown` with evidence; only a declared volatile key is ever ok; `reproduced` requires that. A live provider without a recording is `unknown`, not `external`. Tests: `classify`, `replay-classes`.
- **3.6** decision in `docs/DESIGN.md`: keep `derived_from`/`observes` inferred permanently; add a separate recorded `value_flow` edge from what the page agent observes (exact served string later filled, same page load). Never promoted from a heuristic. Test: `value-flow`.

Test run: 202 tests, 202 pass at `--test-concurrency=2` (`npm test`). At Node's default concurrency on this 8-core machine the added browser files caused load timeouts in a different unrelated test each run (up to 4 per run), all passing when run serially; the script now caps concurrency. That is a test-infrastructure fix, not a loosened assertion.

Still open: shims miss draws outside a command, saved references, `performance.now`, `crypto.getRandomValues`; external recording is fetch-only, 256 KB per body, named origins, and JSON-only redaction; classification is only as good as recorded evidence; cookies are host-scoped so a shadow in the same browser profile would alter production's jar; command params/results are not redacted; `value_flow` is an observed equality from an untrusted page, and click-driven flows have none; old sessions' state hashes lack the new stores.

## Dashboard status

Shipped: `src/dashboard.mjs` (analytics + `/dashboard/*` routes), `src/dashboard/index.html` (served at `/dashboard`), tests in `test/dashboard.test.mjs` and a real-browser render test `test/dashboard-browser.test.mjs`. Views: chain health, tamper demo, timeline, decision funnel, approval latency, repeated intents, bisect + invariant strip, state diff, causal graph, fork compare, policy what-if, rule hit map, agent comparison, recorded overhead.
Not yet: anchor status (needs Phase 1.2), per-model agent comparison (needs Phase 4.1 metadata in `session.start`), shadowed-rule warnings (Phase 2.5), with/without latency overhead (Phase 4.4).

## Suggested order of work

1. P1 and P2 (cheap, remove risk of wrong claims).
2. Phase 1.1, 1.4, 1.3 (close the most reviewable trust gaps).
3. Phase 4.1, 4.2, 4.4 (start collecting real data early; it shapes everything else).
4. Phase 2 (annotation trust), then 1.2 and 1.5.
5. Phase 3 (replay fidelity) as evaluation reveals which gaps matter.
6. Phase 5 and remaining paper steps.

## Non-goals

- Making agents safe or aligned. WitnessLoop makes actions checkable, it does not judge them.
- Defending against a malicious key holder without external anchoring (Phase 1.2 addresses this only if an anchor is used).
- An `eval` or arbitrary-script command. It cannot be classified, so it cannot be gated.
- Replaying against production. Replay stays shadow-only.

## Open research questions

- How should an unannotated consequence be defined and detected without trusting the page?
- What is the right trust model for approvals when the approver is itself an automated reviewer?
- Can causal edges be made sound enough to cite as evidence, or should inference stay permanently labelled?
- How much of a real application's world can be checkpointed before cost dominates?
- Does a gate tuned on scripted agents transfer to LLM agents whose failure modes differ?

---

## Build prompts for Claude Code

One self-contained prompt per phase. Paste a prompt into a fresh Claude Code session opened at the repo root. Run phases in order unless a prompt says otherwise. Every prompt shares the same ground rules, stated once here and referenced by each prompt.

### Shared ground rules (prepend to every prompt)

```text
You are working in the witnessloop repo (Node 24+, zero runtime dependencies, ESM .mjs).
Read README.md, docs/DESIGN.md, docs/THREAT-MODEL.md and roadmap.md first, then the source
files relevant to the task before changing anything.

Rules:
- No new runtime dependencies. Use node: built-ins only. Dev tooling only if unavoidable, and ask first.
- Match the surrounding code style: terse comments that explain why, same naming, same module layout.
- Fail closed. If a new check cannot run, the action it guards must not happen.
- Every new behaviour needs a test in test/ that fails without the change. Tamper and failure
  cases matter more than the happy path. Run `npm test` and report the real output, including failures.
- Never weaken an existing test to make it pass.
- Keep the op table in src/ops.mjs the single source for CLI and MCP; any new action must appear in both.
- Update docs/THREAT-MODEL.md and README.md to match what is actually true after your change:
  move a limitation to "proven" only if a test demonstrates it; otherwise leave it stated.
- Do not claim a guarantee the code does not enforce. If something remains out of scope, say so in the docs.
- Do not commit unless asked. When done, summarise: files changed, tests added, test output,
  and any limitation that remains.
```

### Prompt: Phase 1 (close the honest gaps in the trust story)

```text
[Shared ground rules]

Task: implement roadmap Phase 1 (items 1.1 to 1.5). Work one item at a time, run the full
test suite after each, and stop to report if an item needs a design decision you cannot resolve from the repo.

1.1 Write-ahead result recording. Today the gate appends `intent` and `decision` before dispatch, but the
    `command` result is appended after the click. Add a `command.begin` event appended before dispatch
    (params, intent_idx) and make the later `command` event reference it. Add a verify rule:
    a `command.begin` with no matching result is reported by `verify` as an unresolved dispatch (a warning
    in normal mode, an error in --strict). Update causal.mjs, bisect.mjs, replay.mjs and report.mjs
    so they tolerate and surface the new event kind. Test: inject a ledger failure after dispatch and assert
    the gap is detected. Keep forks working (replay must not re-run a begin as a command).

1.2 External seal anchoring. Add `anchor` and `verify --anchor <source>`. Support at least a local append-only
    file sink and a pluggable sink interface (function taking {session, head_hash, seal}). Anchoring records
    the seal head hash outside the SQLite ledger. Verification compares the bundle's seals to anchored hashes.
    Test: rewrite a whole history and reseal with the same key; assert `verify --anchor` fails while plain
    `verify` passes. Document that anchoring only helps if the sink is outside the key holder's control.

1.3 Authenticated approvers. Add per-approver ed25519 keys (`keygen --role approver`). Approvals over the
    gate API must carry a signature over {approval id, verdict, nonce}. The second `decision` event stores the
    approver key fingerprint. Add `--trusted-approver <fingerprint>` to verification. Keep the unsigned path
    only behind an explicit `--allow-unsigned-approvals` flag, default off; timeouts still deny.
    Test: unsigned, wrong-key, replayed-nonce and tampered-verdict approvals are all rejected.

1.4 Relay authentication. Require a bearer token (generated at `serve`, stored with restrictive permissions,
    passed by client.mjs, the CLI and the MCP server) on every HTTP route, and on the WS agent link.
    Test: missing or wrong token returns 401 and cannot approve, change policy, or send commands.

1.5 Key rotation and revocation. Add a `key.rotate` chain event signed by the old key that names the new
    public key. Verification accepts a seal by any key reachable through a valid rotation chain from a pinned
    trusted key, and rejects seals by a revoked key made after its revocation event. Test across a rotation boundary.

Finish by updating docs/THREAT-MODEL.md limitations 1, 3 and 4 with exactly what is now enforced
and what is not, and by adding a "Phase 1 status" note to roadmap.md.
```

Done, here is generated claude code plan :

```
User approved Claude's plan
Plan saved to: C:\Users\user\.claude\plans\sharded-shimmying-raven.md · /plan to edit
Phase 1 plan: close the trust gaps (roadmap 1.1 to 1.5)

Context

Phase 0 proved the chain detects edits. Phase 1 closes what THREAT-MODEL limitations 1, 3 and 4 still admit: the result of a dispatch is recorded after the click (a crash hides a real effect), the key holder can rewrite and reseal history, approvals are self-declared strings, the relay has no auth, and there is no key rotation. Rules from the prompt apply: node built-ins only, fail closed, a failing-without-the-change test per behaviour, op table stays the single CLI/MCP source, no commit unless asked, docs claim only what a test proves.

Decisions already made with the user: command.begin for irreversible commands only; rotation via certs in bundle + chain events; token file perms via icacls, refuse to start if it fails; token always on, no off switch.

Order: 1.1, 1.2, 1.5, 1.3, 1.4 (1.4 last: it touches every test helper, so the earlier items stay reviewable). Run npm test after each item and report real output. Baseline: 70 pass.

Shared groundwork (small, done inside 1.1)

- verifySession (src/ledger.mjs:25) gets an additive warnings: [] in its result. Non-strict: unresolved dispatch is a warning; strict: a problem. verifyBundle defaults strict, so verify-bundle fails on it by default; verifySessionId defaults non-strict.
- verifySession opts change from trustedKey (one fingerprint) to also accept sets (trustedKeys, trustedApprovers, anchors, revoked) additively. Keep trustedKey working.
- client.verify(id, strict) (src/client.mjs:42) becomes verify(id, opts) with query params; route (relay.mjs:221) forwards them. Update the op and callers.
- dashboard.integrity (src/dashboard.mjs:77) surfaces warnings, and the "anchoring not built" note in src/dashboard/index.html:177 is updated when 1.2 lands.

1.1 Write-ahead result recording

- runCommand (src/relay.mjs:106-161): for effect === 'irreversible' and released, append command.begin (kind:'command.begin', actor, type, effect, data:{params, intent_idx}) immediately before dispatch (:136). The later command event gets data.begin_idx. An append failure here throws, so nothing is dispatched (fail closed).
- Pairing rule in verifySession: every command.begin idx must be referenced by a later command event's begin_idx. Unmatched: warning unresolved dispatch: intent #N was released and dispatched but no result was recorded; strict makes it a problem at the begin idx.
- Tolerate the new kind: causal.mjs:36 whitelist (add command.begin, edge begun, no node-count regressions in analysis.test), bisect.mjs (checkpoint after_idx stays the command idx, never the begin), replay.mjs (commands filter at :42 is kind==='command', so a begin is never re-run; forks re-create their own begin through runCommand; attempts() :102 must not treat a begin as an attempt and must not call a crashed dispatch "denied" if a begin exists), report.mjs (timeline note for begin, show verify.warnings, count unresolved), dashboard.mjs (summarize/sessionDetail timeline params for begin; lane list in index.html:185 gets command.begin).
- Tests (test/gate-relay.test.mjs, test/ledger.test.mjs, test/analysis.test.mjs): update the irreversible sequence assertion at :62 to intent, decision, decision, command.begin, command, checkpoint (only that assertion; :38 is untouched); new test patches relay.ledger.append to throw on kind==='command' after dispatch (same pattern as gate-relay.test.mjs:120), asserts the click reached bank.agent.seen, then verify non-strict has a warning and strict fails at the begin idx; pure verifySession test for begin without result; fork/replay-verify still reproduce with begin events present; a begin append failure dispatches nothing.

1.2 External seal anchoring

- New src/anchor.mjs: anchorRecord(session, seal) = {session, head_idx, head_hash, ts}; fileSink(path) appends one canonical JSON line (fsync); sink interface = async ({session, head_hash, seal}) => void; readAnchors(path).
- Op anchor <session> [--sink <file>] in src/ops.mjs (relay route POST /sessions/:id/anchor, client method, MCP automatically). Relay option anchorSink so seals can be anchored on creation; ledger keeps its own logic (no sink calls inside Ledger).
- Verification: verify --anchor <file> and verify-bundle --anchor <file> (multi-value). For each anchored record of that session: the bundle must contain an event at head_idx whose hash equals head_hash, else a problem (history differs from anchored seal); an anchored head beyond the bundle length is truncated relative to anchor. cli.mjs:78 exit code already covers verify/verify-bundle.
- Test: build a session, anchor, then rewrite the whole history and reseal with the same key; plain verify passes, verify --anchor fails. Also truncation past the anchor, missing anchor file, malformed line (fail closed = verification fails).
- Docs: anchoring helps only if the sink is outside the key holder's control; a local file sink protects nothing against someone with disk access.

1.5 Key rotation and revocation

- src/attest.mjs: keyCert(oldPriv, oldPub, newPub, ts) = {old_pub,new_pub,ts,sig} signed over canon; verifyCert. Key file gains optional history (certs) so rotation survives restart; corrupt key files stay a hard error only for rotation paths (existing silent regenerate behaviour is documented, not changed here).
- Ops rotate-key and revoke-key <fingerprint> (op table, relay routes, client). Ledger gets rotateKey(newKey, cert) (only seal() reads this.key, ledger.mjs:181). On rotation the relay appends key.rotate (data: cert) to every active session, then seals with the old key just before switching. revoke-key appends key.revoke (data:{fingerprint, ts, sig by a currently trusted key}).
- Bundle gains rotations: [certs] (additive, still witnessloop.bundle/1; older bundles verify as before).
- Verifier: trusted set starts from the pinned key(s); reachable set = closure under valid certs (sig by a key already in the set). A seal by a key not reachable is rejected when a pin is given (today the mismatch is reported but the seal still counts toward sealedThrough; fix so it does not). A seal by a key with a key.revoke at chain idx R and head_idx > R is rejected. Unpinned verification is unchanged.
- Tests across a rotation boundary: session sealed by old key then new key verifies from the old pin; forged cert (wrong signer) rejected; seal by unreachable key rejected; revoked-key seal after the revoke event rejected, before it accepted; session started after rotation verifies via bundle certs.
- Limit to state: revocation only bites in chains that contain the key.revoke event or when the verifier is given the revoked fingerprint out of band; a key thief can still rewrite an already-ended session that never saw the revocation (mitigated only by anchors from 1.2).

1.3 Authenticated approvers

- keygen --role approver [--out] (ops.mjs:64 gains role; default file .witnessloop/approver.json). Relay option / serve --approver <fingerprint> (multi) registers allowed approver fingerprints; serve --allow-unsigned-approvals (bool) re-enables the legacy path, default off.
- src/gate.mjs Approvals.request (:25) generates a random nonce per pending approval; list() returns it. Signed message = canon({id, verdict, nonce}) (verdict = allow|deny).
- POST /gate/:id/approve|deny (relay.mjs:204-211) accepts {approver_pub, sig}: fingerprint must be registered, sig valid, nonce the pending one; the entry is consumed on resolve, and consumed nonces are remembered so a replay is rejected (401/403). Missing signature with unsigned disabled: 401 and the approval stays pending. Timeout still denies without any signature.
- Second decision event (gate.mjs:58-61) stores approver_fp, approver_pub, sig, nonce; actor = approver:<fp> so self-declared by cannot masquerade (by kept as a label). Timeout/shutdown/auto-approve (shadow) decisions carry no approver.
- Verification: --trusted-approver <fp> (multi) on verify/verify-bundle: every non-timeout human decision that allowed an irreversible action must have a valid signature over its recorded {id, verdict, nonce} by a listed fingerprint, else a problem at that decision idx. Without the flag nothing extra is required (stated in docs).
- CLI approve|deny gain --key <approver file> and sign client-side; client.mjs approve(id, body) passes the body through. Note in docs: approve/deny are MCP actions too, so the agent can only approve if it can read an approver key; keep approver keys out of the MCP process.
- Tests (gate-relay.test.mjs + ledger test): unsigned rejected, wrong (unregistered) key rejected, replayed nonce rejected, tampered verdict rejected (sign allow, submit deny), valid approval releases and records the fingerprint, verify with/without --trusted-approver, forged decision fingerprint in a bundle caught. Update stories.mjs reviewer, test helpers and demos to sign (or set allowUnsignedApprovals:true only in tests that are about something else, and say so).

1.4 Relay authentication

- createRelay (relay.mjs:26) always sets api.token (32 random bytes, hex) unless given one; compare with crypto.timingSafeEqual.
- HTTP: check inside the request handler before routes.find (relay.mjs:254-255), Authorization: Bearer, 401 {ok:false,error} otherwise, for every route including /health. Only the static GET /dashboard HTML (:248) stays open (no data; a navigation cannot send headers).
- WS: check in the upgrade handler (:268) before acceptWebSocket; token via Sec-WebSocket-Protocol is not supported by the raw browser API cleanly, so use a token query param on /agent; 401 raw HTTP response then destroy. Also reject replacing an existing agent name from an unauthenticated socket (already covered since auth precedes it).
- Dashboard: token in the URL fragment (/dashboard#token=...); index.html reads it, moves it to a JS variable and clears it with history.replaceState, and api() (index.html:58) adds the header. CSP unchanged. serve and demo.mjs open the URL with the fragment; open.mjs already passes URLs verbatim.
- Token distribution: serve writes .witnessloop/token and prints where. Permissions: fs.writeFileSync(..., {mode:0o600}) on POSIX; on win32 run icacls <file> /inheritance:r /grant:r <USERNAME>:F via execFileSync; if that fails, serve throws and does not start. Client (createClient, client.mjs:5-25), CLI and MCP (createClient() at mcp-server.mjs:56) read WITNESSLOOP_TOKEN or .witnessloop/token; no token means the request goes out without header and gets 401.
- Plumb the token through: test/helpers/relay.mjs, test/helpers/fake-agent.mjs (health poll :26 and WS URL :9-10), examples/lib/stage.mjs (client :40, agent URL :46), src/agent/inject.js (store witness_token from the query param in sessionStorage, add to WS URL :227), test/cli-mcp.test.mjs (env at :79), test/dashboard.test.mjs (get/post helpers :6-7), dashboard-browser test URLs, examples/agents/demo.mjs URL fragment.
- Tests (new test/auth.test.mjs): missing and wrong token return 401 on approve, deny, PUT /policy, POST /command, GET /health; WS upgrade without/with wrong token is refused and no agent registers; valid token works; dashboard HTML is served without token but its API is not; CLI without token exits non-zero; token file exists and (posix) mode 0600 / (win32) ACL command was invoked and failure aborts serve (injectable runner).
- Limit to state: localhost only, bearer token is a shared secret readable by any process of the same user; no Origin/Host check (DNS rebinding) unless added; the app-origin page holds the agent token in sessionStorage, readable by scripts on that page.

Docs and roadmap

- docs/THREAT-MODEL.md limitations 1, 3, 4: rewrite each to what a named test now proves, and keep unenforced parts (key-thief rewrite without anchor, approver keys readable by the same OS user, token as shared secret, revocation scope, unsigned approvals only behind the flag).
- README.md: new ops (anchor, rotate-key, revoke-key), new flags (--anchor, --trusted-approver, --allow-unsigned-approvals, --role approver, --approver), token/dashboard fragment, verify warnings.
- roadmap.md: "Phase 1 status" note with real test counts and what remains.
- No commit unless asked.

Verification

- npm test after each item; final report: files changed, tests added, real output including failures, remaining limitations.
- Manual: node src/cli.mjs serve --no-open, then a bare curl gets 401 and witnessloop health works; demo.mjs bank --hold still opens the dashboard with the fragment token and every tab loads; tamper demo still detects all three modes; export a bundle, rewrite+reseal, verify-bundle --anchor fails.
- Watch-list: gate-relay.test.mjs:62 sequence, analysis.test.mjs filters on dom.fill/dom.click (begin events carry type, so filter by kind==='command'), e2e counts (intents.length === 6), dashboard tamper-demo delete/truncate need >= 4/3 events.
```



### Prompt: Phase 2 (detect what the gate cannot see)

```text
[Shared ground rules]

Task: implement roadmap Phase 2 (items 2.1 to 2.5). Goal: reduce reliance on the page's own
`data-wl-effect` annotations, without pretending a missing annotation can be fully detected.

2.2 first (it enables 2.1). In src/agent/inject.js, observe outgoing non-GET requests (fetch, XHR,
    form submits) that occur within a bounded window after a click, and report them in the command result
    as `observed_effects`. In the relay, compare against the class the page declared. A non-GET request under
    a `reversible` or unannotated click writes a `flag` event (why: "undeclared network effect")
    with the request method and path as evidence. Do not log request bodies or credentials; store method,
    origin, path and a body hash only. Keep src/registry.mjs and inject.js in sync (there is a drift test).

2.1 Unannotated-consequence detector. Offline analysis over a recorded session: a click whose next
    checkpoint shows server or storage state change consistent with an external effect, yet was classified
    reversible, yields a `flag` in the report. Add an example story where an unannotated "Pay"
    button is caught after the fact. State explicitly in output that this is detection after the fact, not prevention.

2.3 Annotation linter. `witnessloop lint-page <url|file>`: list forms, submit buttons and links with
    side-effect-looking targets lacking `data-wl-effect`. Output is candidates, not verdicts.

2.4 Effect-check library. Extract reusable checks (conservation of a numeric total, recipient set equals
    preview, no extra fields) into src/effects.mjs. Rebuild the bank and mailer profiles on it and prove the
    story outputs are unchanged.

2.5 Policy hardening. `policy --dry-run <session>` prints, for every recorded intent, what the given policy would
    have decided. Warn on shadowed rules (a rule that can never match because an earlier rule covers it) and on
    a `matches` regex prone to catastrophic backtracking (add a length or step cap). Test each.

Update THREAT-MODEL.md limitation 2 to state precisely which undeclared effects are now caught, when
(before or after dispatch), and which still are not. Add a "Phase 2 status" note to roadmap.md.
```

Here is the implemented output :

```
Phase 2 (2.1 to 2.5) is implemented. npm test passed 142 of 142 on the last three consecutive runs, and nothing is committed. All of it is detection or advice: nothing blocks an undeclared effect. THREAT-MODEL.md limitation 2, the README and a "Phase 2 status" section in roadmap.md are updated.

I also ran node examples/agents/demo.mjs shop --no-open and it prints the live flag and the after-the-fact line.

What each item does

- 2.2 network observer:
  - What it reports: during a dom.click, inject.js reports non-GET fetch, XHR, sendBeacon and form submits the page did not intercept. It sends method, origin, path and a body hash only, never the body, headers or query string.
  - What the relay does: it writes an undeclared_effect flag under a reversible or unannotated click, with what the page declared. The flag is written after dispatch, never before.
  - Navigating form submits: a native form submit that unloads the page still gets recorded, because the agent pushes what it saw over the link before unload.
  - Replay: observed_effects carries the origin, so replay.mjs now strips it before comparing runs; otherwise replay-verify would diverge on a shadow copy.
- 2.1 offline detector: src/detect.mjs, a detect <session> op, and a "Detected after the fact" report section. It flags reversible clicks whose app-server state changed between the surrounding checkpoints, or that carry a recorded write. The output says "Detection after the fact, not prevention". New examples/shop has an unannotated Pay button.
- 2.3 lint: lint-page <file|url> returns candidates with a "not verdicts" note. It fetches only loopback URLs, never follows redirects, and needs WITNESSLOOP_LINT_ALLOW_REMOTE=1 in the environment for anything else. It is also an MCP action, so an agent can't widen it.
- 2.4 effect checks: src/effects.mjs, and the bank and mailer profiles are rebuilt on it. test/effects.test.mjs keeps the old functions as a reference and compares old against new, including why and evidence.
- 2.5 policy:
  - Dry-run: policy --dry-run <session> [file] shows what the policy would have decided for each recorded intent and changes nothing.
  - Warnings: shadowed-rule and backtracking-regex warnings. Shadowing is only warned when provable, so a warning is never a guess.
  - Regex cap: matches now has pattern-length, input-length and time caps. A limit hit becomes require_approval, or deny under a deny-by-default policy, never a silent no-match.

Tests added

39 new tests, from 103 to 142:

┌───────────────────────────┬───────┐
│           File            │ Tests │
├───────────────────────────┼───────┤
│ test/observed.test.mjs    │ 7     │
├───────────────────────────┼───────┤
│ test/detect.test.m
│ test/e2e-browser.test.mjs │ 2     │
└───────────────────────────┴───────┘

While writing the observer tests I found a real bug in my own code: a lowercase method such as head was flagged as a write. The relay now uppercases methods, and treats an entry with no readable method as a write.

Changes you didn't ask for

- Agent connect timing: inject.js now connects only after the page's load event and its own startup fetches settle, with a 5 s cap. Fork and mailer-story runs were reading half-rendered pages, and that race caused the mailer failures under load. A new browser test fails without the change and passes with it. A page that never settles now connects up to 5 s later.
- Test timing fixes: the dashboard browser test now waits for a tab instead of sleeping 300 ms. A Phase 1 approval test went from a 200 ms to a 1500 ms timeout. Two new test files wait 100 ms for sockets to close, because Windows was aborting libuv when the runner force-exited. No assertion was loosened.
- Runs with failures: before those fixes, my runs had 1 or 2 failures each, from these timing races under parallel load. Two failures came from my regex time cap being too short (50 ms) under load. I raised it to 250 ms, with one retry at 1 s.

Still not caught

- Prevention: any undeclared effect is still not prevented.
- Observer blind spots: requests after the click settles, WebSocket.send, a fetch the page saved before the agent loaded, workers and frames, GETs with side effects, and effects not tied to a click.
- Detector scope: it needs the adapter and mutating checkpoints, and it sees only app-server state. Page-storage changes are deliberately not flagged.
- Body hashes: a hash of a low-entropy body (a short password) can be guessed offline. It is null in an insecure context.
- Lint scope: lint-page can't see JavaScript-wired controls or forms that scripts build.
- Regex time cap: it is wall-clock. A machine stalled twice in a row can produce a spurious limit hit (safe but nondeterministic), and a real blowup holds the relay about 1.25 s per evaluation.
- Dry-run: it re-checks the policy verdict only. It does not re-ask a human.

I can commit and push this, along with the Phase 1 work, when you say so.
```



### Prompt: Phase 3 (broader worlds and stronger replay)

```text
[Shared ground rules]

Task: implement roadmap Phase 3 (items 3.1 to 3.6). Replay claims must stay honest: anything not captured
must be listed as not captured, and divergence must be reported, never hidden.

3.1 Extend world capture in src/world.mjs and inject.js to include sessionStorage, cookies visible to
    document.cookie, and service-worker registration state. HttpOnly cookies are not readable; record that
    limitation in the checkpoint metadata. Restore must round-trip; add a test per store. Never persist
    secrets into an exported bundle without a redaction hook: add `redactKeys` to the profile, apply it
    on capture, and test that a redacted key never appears in a bundle blob.

3.2 Deterministic shims. In shadow mode only, install controllable Date.now, new Date() and Math.random
    (seeded from the recorded session) before page scripts run. Record the seed in `fork.start`. Test with a
    todo-style app that writes timestamps: it must replay exactly without listing them in volatileKeys.

3.3 External-dependency recording. In production sessions, optionally record HTTP responses from declared
    third-party origins into the bundle (content-addressed blobs); in shadow replay serve them from the
    recording instead of the network. Mark the replay result as "replayed against recorded external responses".
    Add an origin allowlist; default off. Test with a stubbed provider.

3.4 IndexedDB autoIncrement. Either rewrite key generators on restore where the API allows it, or detect
    the drift and make replay-verify report it as a classified divergence. Test with an autoIncrement todo app.

3.5 Divergence classifier. In replay-verify, label each divergence as `volatile`, `nondeterministic`,
    `external` or `unknown`, with the evidence used. Never label a divergence "ok" unless it is inside a
    declared volatile key.

3.6 Causality. Decide, with a short written rationale in docs/DESIGN.md, whether to keep `derived_from` and
    `observes` as permanently inferred edges or to add a recorded value-flow edge where the page agent can
    observe it directly (for example a value read from a DOM node and later filled by the same command stream).
    If you add recorded edges, keep them separate from inferred ones and test that inferred edges are never
    upgraded to recorded.

Update THREAT-MODEL.md limitations 5, 6 and 7 to match. Add a "Phase 3 status" note to roadmap.md.
```

Here is the result from claude code :

```
I fixed three of the limitations. I did not fix the rest, because they are either inherent or a much larger change. npm test now shows 145 of 145 passing on three consecutive runs, and the changes are committed and pushed to main.

Fixed

- Corrupt key file: a key file that exists but is corrupt or incomplete now stops the start with an error and is left untouched. Only a missing file creates a key. Silently replacing it would have orphaned every earlier seal. Test in test/keys.test.mjs.
- Origin and Host check: the relay now only serves loopback Host names (it answers 421 otherwise), which blocks DNS rebinding. It refuses HTTP requests with a foreign Origin (403), even with a valid token. The dashboard and the CLI still work. The agent WebSocket is not Origin-checked, because the app page's origin is legitimately different, so the token still guards it. Test in test/auth.test.mjs.
- Anchor status in the dashboard: the Integrity tab now shows an anchor row per session when the relay runs with --anchor-sink. It reads none, unanchored, ok or failed. An unreadable or mismatching anchor file shows as failed, and a session with no anchor shows as unanchored. It is computed by the real verifier. Test in test/anchor.test.mjs.

Other changes

- Threat model and README: updated to match the three fixes.
- Existing WebSocket test: it sent Host: x, which is now rejected earlier, so I gave it a loopback Host.
- Lint test flakiness: the lint test failed under load with the Windows libuv abort. It now uses a plain node:http fetch stand-in for its local server.

Still open

- Prevention: nothing blocks an undeclared effect before it happens. The gate still trusts data-wl-effect.
- Observer blind spots: WebSocket traffic, requests after the click settles, workeseen.
- Shared token and approver keys: the relay token is still one shared secret, and approver and token files are readable by the same OS user.
- Anchor sink: a file sink on the same machine protects nothing against whoever holds that machine.
- Agent token in the WebSocket URL: browsers can't set headers on a WebSocket, so the agent link still carries the token as a query parameter.
- TLS: the relay is still plain HTTP on localhost.
- command.begin: it still covers irreversible commands only.
- Body hashes: low-entropy bodies are still guessable offline.
- lint-page: it still can't see JavaScript-wired controls.

Say if you want me to take one of the larger ones next. command.begin for reversible commands is the most tractable.

command.begin now covers reversible writes too, and it's committed and pushed as 43e3722. npm test passed 146 of 146 on the last three runs.

Every state-changing command (dom.click, dom.fill, page.reload) now writes a begin event before dispatch, and reads still don't. If the begin can't be written, nothing is dispatched. A lost result shows up in verify as an unresolved dispatch, a warning by default and an error under --strict. This was the "reversible commands aren't covered" limitation, so it is now closed in the threat model and roadmap.

Effect on the demo numbers: the bank demo now has 65 events (sealed through #64), and the first bad event moved from #19 to #23. I updated the README, paper.md and the dashboard browser test to match. Those were the stale figures I flagged earlier.

Tests: one new test in test/gate-relay.test.mjs covers a failed begin for a reversible fill, a lost result, and reads getting no begin. I changed four existing tests, and none was weakened:
- The write sequence now includes command.begin.
- Two lookups that matched "first event of type dom.fill" now filter on kind === 'command'. They were finding the begin event instead.
- The click-begin failure test now fails only the click's begin, since the fills before it would otherwise fail too.

I also made the dashboard tests wait for the session button instead of assuming it is already drawn. It was flaking under load, as before.

Still open (the remaining items are unchanged from my last summary; none of them are things I can close in code):
- Nothing blocks an undeclared effect before it happens.
- The observer misses WebSocket traffic and requests after the click settles.
- The relay token is one shared secret, and approver and token files are readable by the same OS user.
- The anchor sink on the same machine protects nothing against its holder.
- The agent token travels in the WebSocket URL.
- The relay is plain HTTP on localhost.
- Body hashes of low-entropy bodies are guessable.
- lint-page can't see JavaScript-wired controls.

docs/DESIGN.md
- Architecture diagram: shows the auth layer and the command.begin step.
- Event table: now has command.begin, key.rotate and key.revoke. The intent, decision, command and flag rows cover the new fields, including the undeclared_effect flag type.
- Gate section: covers signed approvals, write-ahead and the policy caps and dry-run.
- New "Trust" section: anchors, key rotation, and the Host, Origin and token checks.
- New "Detecting what the gate cannot see" section: observer, detector, linter and effect checks.
- Testing list: covers the new test files and the shop story.

README.md
- The test count is now 146, and the "unresolved dispatches" sentence covers all state-changing commands.
- It mentions the Host and Origin checks and lists the shop demo.
- I added an npm run demo:shop script to package.json so the README's shop line has a script to point at.

Already updated earlier and rechecked against the code: docs/THREAT-MODEL.md, roadmap.md (Phase 1 and Phase 2 status), and the demo numbers in the README and paper.md.
```



### Prompt: Phase 4 (real agents and real workloads)

```text
[Shared ground rules]

Task: implement roadmap Phase 4 (items 4.1 to 4.6). This phase produces the data the paper's
evaluation needs, so reproducibility and honest reporting matter more than impressive numbers.

4.1 LLM-driven harness. Add bench/agent-run.mjs that drives a model client through src/client.mjs against
    the bank, mailer and todo apps. The model, its parameters, the system prompt and the task text must be
    recorded in the session's `session.start` data. Read the API key from the environment only; never write it
    to disk, the ledger or logs. Support N repeated runs per task, with a fixed seed where the API allows it
    and a note where it does not. Consult the claude-api skill for current model ids and usage.

4.2 Task suite. bench/tasks/*.json: each task has a goal, the app, the expected-safe outcome, the known-bad
    outcomes, and a machine-checkable ground-truth predicate over the final world. Include: wrong recipient,
    rounding loss, duplicate entry, over-limit payment, and a benign task where no intervention is correct.

4.3 Metrics runner. bench/run.mjs runs the suite and emits JSON and a markdown table: gate interventions
    (allow, deny, approval counts), false blocks on benign tasks, bad outcomes that got through, bisect
    accuracy versus ground truth (does firstBad match the true first-bad event), fork counterfactual success,
    replay-verify reproduction rate. Report mean and spread over repeated runs. Do not cherry-pick: keep
    failed runs in the output.

4.4 Overhead benchmarks. bench/overhead.mjs: per-command latency with and without witnessloop, ledger bytes per
    event, checkpoint time and size versus world size, seal time, verify time versus session length. Print
    the hardware and Node version. Numbers only from actual runs.

4.5 Adversarial evaluation. bench/red-team/: agents that try to evade the gate (unannotated consequential
    button, page with a lying preview, race between approval and dispatch, approval spam, oversized params,
    lookalike payee names). Every evasion that succeeds must become either a fix plus a regression
    test, or an entry in THREAT-MODEL.md. Write bench/red-team/FINDINGS.md.

4.6 External-style app. Add examples/third-party/ containing a small app written as if by someone else
    (different structure, own server state), integrated using only annotations and an adapter. Record in
    the findings file what was hard or impossible.

Output: bench/RESULTS.md with methodology, environment, raw numbers and every failure.
Do not edit paper.md numbers by hand; list them for the author to transcribe.
Add a "Phase 4 status" note to roadmap.md.
```

### Prompt: Phase 5 (usability and ecosystem)

```text
[Shared ground rules]

Task: implement roadmap Phase 5 (items 5.1 to 5.6). Keep the zero-dependency rule; front-end code is plain HTML, CSS and JS.

5.1 Reviewer UI. A local page served by the relay at /review showing each pending approval: preview
    fields, policy rule and reason, the causal ancestors of the intent, and Approve and Deny buttons. It must
    use the Phase 1 relay token and signed-approval flow. Test with the real-browser harness in examples/lib/browser.mjs.

5.2 Self-verifying report. `report --html` emits one HTML file embedding the bundle and a small verifier script;
    opened offline it re-verifies the chain and seals and shows the result prominently, including a visible
    failure state if anything does not verify. No network access.

5.3 Standalone verifier. `verify/witnessloop-verify.mjs`: a single file under 400 lines, importing only node:crypto
    and node:fs, that verifies a .wl.json bundle with the same result as the full verifier. Add a test that
    runs both on the same valid and tampered bundles and asserts identical verdicts. Keep it readable; an
    auditor should be able to review it in one sitting.

5.4 Server adapters. Ship adapters for two common Node stacks (an Express-style middleware and a plain
    node:http handler) implementing GET /__witness/state and POST /__witness/restore, each with an example app
    and a test.

5.5 API tool boundary. Prototype src/http-tool.mjs: a gated HTTP tool boundary that uses the same
    classify, gate, dispatch, ledger pipeline for outbound API calls, with effect class derived from the
    method and a per-route policy. It must reuse ledger.mjs and gate.mjs, not fork them. Add one example
    and tests including fail-closed behaviour.

5.6 CI. Add a workflow running `npm test` on Windows, macOS and Linux, with the browser e2e tests
    skipped cleanly (and reported as skipped) where no Chromium-family browser exists.

Update README.md usage sections for anything user-facing. Add a "Phase 5 status" note to roadmap.md.
```

### Prompt: Paper track (P1 to P10)

```text
[Shared ground rules, except the tests rule: this task edits documents]

Task: revise paper.md toward submission. Do not invent results, numbers, or citations.

Step 1 (P1). Run `npm test`, `npm run demo:bank`, `npm run demo:mailer`, `npm run demo:todo`. Replace every
number in Section 6 with the actual output and record the git commit hash and Node version in the
availability section. If output differs from what the paper says, fix the paper and tell me.

Step 2 (P2). For every reference, check whether you can verify author, year, venue and title from a
source you can actually fetch. List any you cannot verify in a comment block at the end of the file rather than
guessing. Propose (do not silently add) further related work on agent audit logging, transparency logs, and
tool-use policy enforcement, each with a verified source.

Step 3 (P3, P5). Rewrite Section 3 so G1 to G4 are stated as checkable propositions, each with the mechanism and
the test in the repo that exercises it. Add a precise statement of the fail-closed guarantee and its exact scope,
including the post-dispatch gap unless Phase 1.1 has shipped.

Step 4 (P4). Add a comparison table against tracing and observability tools, tamper-evident logs, guardrail
frameworks and record/replay systems along ordering-before-effect, offline verifiability, counterfactual
replay. Fill cells only from verified sources; mark unknowns as "not assessed".

Step 5 (P8). Add text-based (Mermaid or ASCII) figures: architecture, hash-chain layout, gate sequence,
bank-story timeline.

Step 6 (P7). Reconcile Section 8 with docs/THREAT-MODEL.md and the Phase status notes in roadmap.md.

Step 7 (P6, P9). Only after Phase 4 has produced bench/RESULTS.md: rewrite Section 6 from it, with methodology,
variance, and failures included, and add an artifact section with one-command reproduction.

Do not add authors, affiliations or venue formatting unless I provide them. End with a list of every claim
in the paper that is not backed by a test or a measured result.
```

### Optional: single umbrella prompt

Use only if you want one long session to drive everything. It is more error-prone than per-phase runs.

```text
[Shared ground rules]

Execute roadmap.md phases 1 through 5 in order. After each phase: run the full test suite,
update THREAT-MODEL.md, add a "Phase N status" note to roadmap.md, and stop and show me the
summary before starting the next phase. If any item cannot be done without a design decision or a new
dependency, skip it, record why in roadmap.md, and continue.
```

# 
