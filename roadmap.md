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
