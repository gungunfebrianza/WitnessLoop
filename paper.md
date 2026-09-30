# WitnessLoop: Provable Autonomy for AI Agents at the Tool Boundary

**Abstract.** AI agents are being deployed into systems where actions have consequences: payments, filings, trades, collateral releases. Yet the evidence standard for machine action remains *observability* (logs and traces that record what a system claims happened) rather than *provability* (evidence a third party can check without trusting the system that produced it). We argue the tool boundary, the point where an agent's decision becomes an effect in the world, is the right place to close this gap. We present WitnessLoop, a zero-dependency system that mediates a browser agent's actions and provides four properties an ordinary instrumented agent lacks: (1) a per-session, hash-chained, content-addressed, ed25519-sealed ledger whose tampering is detected at the exact event, offline; (2) a two-phase gate in which an `intent` and a policy `decision` are durably recorded *before* any irreversible effect is dispatched, failing closed if the record cannot be written; (3) forkable world checkpoints that let a recorded session be re-run in a shadow copy of the application under a changed parameter, skipped step, or patched policy; and (4) `replay-verify` and `bisect`, which turn "it reproduces" and "it broke here" into checkable results. We evaluate on three example applications (a bank with a planted rounding bug, a mailer whose page silently BCCs an outsider, and a purely client-side todo list) using a real headless browser, and we state precisely what is and is not proven. WitnessLoop does not claim to make agents safe; it claims to make what they did *checkable*.

**Keywords:** AI agents, accountability, tamper-evident logging, two-phase commit, record and replay, counterfactual replay, tool use, audit.

---

## 1. Introduction

Agents that act, not merely answer, are moving into settings where mistakes cost money and cannot be taken back. An agent that clicks "Send" on a payment form, submits a filing, or releases collateral produces an effect that persists after the session ends. When something goes wrong, three questions follow: *What exactly did the agent do? Who or what allowed it? Would a different rule have prevented it?*

The prevailing answer to these questions is observability: traces, structured logs, screenshots, and dashboards. Observability is valuable, but it is an *assertion by the system about itself*. A log says what the logging component claims happened. It can be edited, truncated, or reordered after the fact; it is typically written *after* the consequence rather than before; and it cannot answer counterfactual questions except as a story. For actions with legal or financial weight, the standard we need is closer to *provability*: a record that a skeptical third party can verify offline, that demonstrably preceded the consequence, and that can be re-executed to test claims about cause.

This paper makes the following contributions:

1. **A framing.** We separate the evidence standard for machine action into observability ("the system says what happened") and attested causal replay ("a claimed action can be re-executed from a checkpoint and shown to follow from recorded causes"), and we locate the enforcement point at the *tool boundary*.
2. **A design.** WitnessLoop, a relay plus in-page agent that classifies every agent command by consequence, gates irreversible ones with a two-phase protocol, and records everything in an attested ledger (Sections 3-4).
3. **Analyses built on the record.** Causal graph construction that keeps recorded and inferred edges apart, `bisect` for first-failure localisation, fork/counterfactual replay, and `replay-verify` (Section 5).
4. **An honest limits statement.** An explicit threat model listing what is proven, what is not, and why (Sections 7-8).

## 2. Background and Related Work

**Tamper-evident logging.** Hash-chained logs and signed commitments to a log head are established techniques for making history hard to rewrite silently (Crosby and Wallach, 2009; RFC 6962 for Certificate Transparency). WitnessLoop uses a per-session chain, `hash = sha256(prev_hash + canon(event))`, so each session exports as a self-contained bundle, and signs chain heads with Ed25519 (Bernstein et al., 2012).

**Policy enforcement at a mediation point.** Reference monitors and enforceable security policies (Saltzer and Schroeder, 1975; Schneider, 2000) motivate placing a check where every action must pass and failing safely when the check cannot run. WitnessLoop's gate applies this to agent commands.

**Two-phase protocols.** The idea of making a decision durable before acting on it echoes two-phase commit (Gray, 1978). Here the "prepare" phase is the durable recording of intent and verdict, and the "commit" phase is the dispatch of the effect.

**Record and replay; failure isolation.** Deterministic record-and-replay systems (O'Callahan et al., 2017) and failure-isolation methods such as delta debugging (Zeller, 2002) and `git bisect` inform our replay and bisect design. Unlike systems-level replay, WitnessLoop replays at the level of *application state* (browser storage plus server state exposed through an adapter) against a *shadow* copy of the app.

**Observability for agents.** Existing agent tooling largely offers tracing and evaluation. The gap we address is not more telemetry but a different *kind* of evidence: verifiable, ordered-before-effect, and re-executable.

WitnessLoop is a lean re-implementation of the core of an earlier in-house tool, web-scout (a WebSocket relay plus in-page agent), adding the four capabilities listed in the abstract.

## 3. Problem Statement and Design Goals

We consider an agent that operates a web application through a bounded command interface, in a logged-in session, where some clicks have irreversible effects. We want:

- **G1. Integrity.** Any edit, deletion, reordering, or truncation of the recorded sequence is detectable, offline, at the exact event.
- **G2. Precedence.** For every irreversible effect, a record of the intent and the authorising decision exists *before* the effect, and if it cannot be written, the effect does not occur (fail closed).
- **G3. Counterfactual testability.** Claims of the form "if X had been different, Y would not have happened" can be tested by re-running the recorded past in a disposable copy of the system.
- **G4. Reproducibility as a fact.** "This reproduces" is a checkable comparison, not an assertion.
- **G5. Honesty about scope.** Every guarantee has a stated boundary.

Non-goals: preventing a malicious key holder from rewriting history, authenticating human approvers, or capturing external systems (Section 8).

## 4. System Design

### 4.1 Architecture

A relay process sits between callers (CLI, MCP server, or script) and browser pages. Callers speak HTTP to the relay; pages hold a WebSocket to it. Every command flows through one pipeline in the relay: **classify, gate (if irreversible), dispatch, ledger append, checkpoint, effect check**. The ledger is a SQLite database (`node:sqlite`) with an `events` table and a content-addressed `blobs` table. Analysis modules (causal, bisect, replay, report) read only from the ledger. The CLI and the MCP server are driven by a single operation table, so both expose the same action names.

The system has no third-party dependencies and requires Node 24 or later.

### 4.2 Classifying consequence at the tool boundary

Every command an agent can issue is registered with an effect class:

| Class | Meaning | Example commands |
|---|---|---|
| `read` | no state change | `dom.query`, `dom.text`, `dom.describe`, `dom.wait`, `page.info`, `ping` |
| `reversible` | changes state, undone by restoring a checkpoint | `dom.fill`, `page.reload` |
| `irreversible` | leaves the sandbox (money moves, message sent); gated | annotated clicks |
| `dynamic` | class decided per target | `dom.click` |

For `dynamic` commands, the page's own `data-wl-effect` annotation decides the class (a click may not be `read`; an unannotated element defaults to `reversible`). An *unrecognised* annotation value is treated as `irreversible`, so a malformed annotation fails closed. A test enforces that every registered command is classified, and a static drift check keeps the registry consistent with the in-page agent.

A deliberate design choice is that there is **no `eval` command**. An unbounded write cannot be classified by effect and therefore cannot be gated; the command surface is restricted to operations whose consequence can be named.

### 4.3 The attested ledger

Each session forms its own hash chain. The genesis `prev_hash` is 64 zeros. An event's hash commits to its predecessor and a canonical serialisation of the event body. Event payloads (parameters, results, world snapshots) are stored as content-addressed blobs, and each event commits to its payload via `data_hash`; checkpoints additionally commit to a `world_hash`.

The event kinds are:

| Kind | Written when |
|---|---|
| `session.start` | a session opens (goal, actor, agent, parent) |
| `checkpoint` | at genesis, after every state-changing command, or manually |
| `intent` | before an irreversible click, with the page's own `preview` of it |
| `decision` | policy verdict, then human resolution if approval is required |
| `command` | after dispatch, with params, result, error, timing |
| `flag` | the actual effect differs from the previewed effect |
| `fork.start` | first event of a fork; anchors to the parent |
| `session.end` | session closes, followed by a seal |

**Seals.** An Ed25519 signature over the chain head is appended at every 50 events and at `session.end`. Seals carry the public key, and a verifier may pin a trusted key fingerprint. In `--strict` mode the tail must be sealed, so truncation of the unsealed tail is detected.

**Offline verification.** `verify-bundle` checks an exported `.wl.json` bundle without the relay or the database. The test suite covers each tamper class: field edit, blob edit, deletion, swap, truncation, forged or foreign seal, and recomputation of all hashes.

### 4.4 The two-phase gate

Only `irreversible` commands pass through the gate:

1. **Phase 1 (prove).** Append an `intent` event (parameters, element description, and the page's preview of the form fields). Evaluate policy against the context. Append a `decision` event.
2. **Resolution.** If the verdict is `require_approval`, the request waits in an approvals queue for a human `approve` or `deny`; a timeout (default 300 s) is a denial. The resolution is appended as a second `decision`, linked to the first by `resolves_idx`.
3. **Phase 2 (act).** The click is dispatched only if the final decision is `allow`.

Ledger appends in phase 1 are not caught by the gate. If the ledger cannot record the intent or the decision, the error propagates and nothing is dispatched. This is the operational meaning of "the proof precedes the consequence," and it is tested with an injected ledger failure. A denied intent leaves no `command` event because the command never ran.

**Policy.** Policies are declarative JSON: an ordered list of rules with a `default`; the first match wins. Conditions address paths into `{type, effect, params, preview, target, agent, actor}` using operators `eq, ne, lt, lte, gt, gte, in, nin, matches, exists`. An unknown operator is a validation error. The default verdict, absent a policy, is `require_approval`. For example, the bank policy allows an irreversible payment of at most 150 to a known payee, denies anything above 5000, and otherwise requires approval.

**Effect check.** An optional per-application `effectCheck({preview, before, after})` compares the page's preview with the actual world diff and records a `flag` when they disagree. This is the defence against a page whose preview is inaccurate.

### 4.5 World checkpoints

A world is `{page: {localStorage, indexedDB, url}, server}`. Page state is captured by the in-page agent. Server state is exposed by an optional adapter (`GET /__witness/state`, `POST /__witness/restore`). A `stateHash` compares only storage and server state, excluding the URL and application-declared `volatileKeys` (for example, timestamps). A checkpoint is taken at genesis and after every state-changing command, so each step has a stored world before and after it.

## 5. Analyses over the Record

### 5.1 Causal graph

From one session's events, WitnessLoop builds a graph with two disjoint edge families. *Recorded* edges (`decided`, `resolved_by`, `released`, `state_after`, `flagged`, `retry_of`, `verifies`) are structure the system wrote. *Inferred* edges (`derived_from`: a written value first appeared in an earlier read; `observes`: a read shortly after a write on a different target) are heuristics, are tagged `inferred: true`, and are never presented as proof of influence.

### 5.2 Bisect: failure becomes a bug, not an incident

Given an application-defined invariant over a world, `bisect` finds the *first recorded event* after which the invariant stops holding. Because each state-changing event is followed by a checkpoint, the invariant is evaluated on stored worlds and nothing is re-executed. Two strategies are offered: `linear` (checks every checkpoint; always correct) and `binary` (O(log n) evaluations; assumes breakage is monotone). The report gives the offending command, the page's preview of it, who approved it (policy or a named approver), the world diff against the last good checkpoint, and its causal ancestors. Bisect finds the first failing *recorded state*, not a root cause in code.

### 5.3 Fork and counterfactual replay

To fork at event N, WitnessLoop restores the last checkpoint before N into a *shadow* agent (server state via the adapter, page state via `world.restore` and a reload), opens a child session, records a `fork.start` event that stores the parent head hash and restored world hash, and re-executes every recorded `command` at or after N through the *normal pipeline*. The fork is therefore itself gated, checkpointed, and verifiable. A fork can override a parameter, skip steps, or apply a different policy. Shadow forks auto-approve `require_approval` decisions because a disposable copy has nothing to protect, but an explicit `deny` still denies. Refused intents are never replayed, since they never ran. `compare` aligns *attempts* (commands, and intents that were refused) and reports the first divergence. Forks are restricted to shadow environments; production is not touched.

### 5.4 Replay-verify

`replay-verify` restores the genesis checkpoint on a shadow app, re-runs every step, and compares the normalised step results and the final world hash to the recording. A session is "reproduced" only if all match; otherwise the first divergence is reported. A nondeterministic application will report divergence, which is the correct answer.

## 6. Evaluation

We evaluate with three example applications, each with a scripted, deliberately imperfect agent, run against a real headless Chromium-family browser. The project's test suite comprises 52 tests: ledger tamper cases, gate and relay behaviour over a real WebSocket with a fake page, analysis tests, CLI/MCP parity, and real-browser end-to-end tests. The figures below are those reported by the project's demo scripts (`npm run demo:bank`, `demo:mailer`, `demo:todo`).

### 6.1 Bank: a planted rounding bug

The agent makes payments; the application has a fee-rounding bug that loses a cent on amounts containing cents. Policy lets small payments to known payees through, holds a 300 payment for a human reviewer, and denies 999999 as over the hard limit. Reported results:

- The session ledger verifies (49 events, sealed through event #48).
- `bisect` identifies event #17, a transfer of 33.33 to `carol`, as the first bad event: money is not conserved (total 174999 against 175000, a loss of one cent), and policy had approved it.
- Forking onto the shadow app under a *patched boundary* (a rule denying amounts with cents) refuses 2 steps. Production total is 174998; the shadow total is 175000, as required, with production untouched.
- The exported bundle verifies offline, and flipping a single payload byte at event #2 is caught.

This demonstrates the loop the paper argues for: an incident is localised to one recorded event, attributed to an approver, and a candidate fix is *tested against the recorded past* rather than argued.

### 6.2 Mailer: a page that lies about its effect

The page BCCs an outsider. The agent, given two contacts named Sam, picks the wrong one. The gate flags the mismatch between preview and actual effect; the external recipient is refused by a human reviewer before anything leaves; `replay-verify` on the shadow app shows the leak is deterministic; and a counterfactual fork that skips one send lets the story confirm the leak in the fork's outbox. This exercises the effect check and the precedence property: the wrong recipient never receives the contract because the decision precedes dispatch.

### 6.3 Todo: no irreversible effects

The agent edits a client-side list held entirely in IndexedDB. No intent is recorded, so the gate never fires and no human is asked. `replay-verify` reproduces the session across its steps with volatile `created` timestamps normalised. `bisect` finds the first event that violates the profile's invariant (a duplicate entry), and a fork that skips that step yields a shadow with the duplicate absent while production is unchanged. This shows the system imposes no approval overhead where none is warranted.

### 6.4 Threats tested

The test suite covers ledger tampering in each class listed in Section 4.3; ordering, denial leaving no command event, approval timeout, and fail-closed behaviour under an injected ledger failure; linear and binary bisect agreement with binary using fewer evaluations; fork under a patched policy, parameter override, and shadow-only refusal; and replay-verify in both a positive and a negative case. We note that these are functional tests of the mechanisms on small applications, not an adversarial evaluation or a study of realistic agent workloads.

## 7. Threat Model: What Is Proven

| Claim | Mechanism | Detected how |
|---|---|---|
| The sequence was not edited, reordered, or thinned | per-session hash chain | first bad `idx` |
| A payload was not altered afterwards | `data_hash`, `world_hash`, content-addressed blobs | blob no longer matches its hash |
| The record was not truncated | seals every 50 events and at session end; `--strict` requires a sealed tail | seal covers a missing event or unattested tail |
| The seal came from a trusted key | key fingerprint pinning (`--trusted-key`) | untrusted signer |
| A fork branched from the recorded past | `fork.start` stores parent head hash and world hash | fork anchor mismatch |
| The proof preceded the consequence | intent and decision appended before dispatch; ledger failure aborts dispatch | chain order; injected-failure test |
| A session reproduces | shadow re-run compared with normalised results and final world hash | first divergence |

## 8. Limitations

We state these plainly because a provability claim that overreaches is worse than none.

1. **Key custody.** The signing key is stored locally. Whoever holds it can rewrite and reseal a whole history. Seals give tamper *evidence* against later editors who lack the key, not against the key holder. Anchoring a seal's `head_hash` in a system the key holder cannot rewrite is the remedy and is not built in.
2. **Annotations are the page's word.** The gate acts on `data-wl-effect`. A button that charges a card but is unannotated is treated as reversible; a missing annotation cannot be detected. Unrecognised values fail closed. The `effectCheck` hook mitigates lying previews but must be written per application.
3. **Unauthenticated relay.** The relay binds to localhost only, but any local process can approve. `approve --by` is a self-declared name. Approvals should not be treated as authenticated human sign-off without authentication in front of the relay.
4. **Append failure after dispatch.** Fail-closed covers `intent` and `decision`. If the `command` result cannot be recorded after the click has already happened, the effect exists without its result event.
5. **Replay fidelity.** Replay is scoped to a shadow environment and app-declared volatile fields. It cannot reproduce effects that depend on the outside world (third-party APIs, real email).
6. **World coverage.** Checkpoints hold localStorage, IndexedDB, and the server state the adapter exposes. Cookies, sessionStorage, service workers, and external systems are not captured. IndexedDB `autoIncrement` key generators cannot be rewound, so applications intended for exact replay should use explicit ids; the agent warns in the `world.restore` reply.
7. **Causal edges.** `derived_from` and `observes` are heuristics and must not be quoted as proof of influence.
8. **Bisect.** It evaluates an app-defined invariant on stored checkpoints; binary search assumes monotone breakage; it locates a recorded state, not a code-level root cause.
9. **Surface area.** With no `eval`, the agent cannot run arbitrary script, but `dom.click` and `dom.fill` can still drive any UI the page exposes. This is precisely why the gate exists.

More broadly, the evaluation is on three small, purpose-built applications with scripted agents. We make no claim about LLM-driven agent behaviour, performance at scale, or coverage of real-world web applications.

## 9. Discussion

**Provability is about the boundary, not the model.** WitnessLoop makes no attempt to inspect or constrain the agent's reasoning. It treats the agent as an untrusted proposer and the tool boundary as the place where proposals become consequences. This makes the approach model-agnostic: any agent that acts through the command interface, whether driven from the CLI, an MCP client, or a script, gets the same evidence.

**Shifting incidents into bugs.** The bank story illustrates a change in workflow. Instead of arguing about a loss from logs, an operator localises the first violating event, sees who allowed it, and tests a policy patch against the recorded past in a shadow copy. The record becomes an executable artifact.

**Where proof stops.** The strongest claims here are about *ordering and integrity* of a record and *reproducibility in a shadow*. The weakest are those that depend on a trustworthy annotation, a trustworthy approver identity, or a trustworthy key holder. We think making that boundary explicit, and machine-checkable where possible, is itself a contribution.

## 10. Future Work

Directions that follow from the stated limits: anchoring seal heads in an external append-only log; authenticated approvers in front of the relay; automatic detection of unannotated consequential elements; write-ahead recording of the command result to close limit 4; broader world capture; and evaluation with LLM-driven agents on real applications.

## 11. Conclusion

As agents are given authority over payments, filings, and other consequential actions, "we have logs" is not an adequate evidence standard. WitnessLoop shows that at the tool boundary a modest set of mechanisms (consequence classification, a fail-closed two-phase gate, an attested per-session ledger, and checkpoint-based fork and replay) can move the standard from observability toward provability, while being explicit about where the guarantees end.

## Availability

WitnessLoop is a zero-dependency Node 24+ project. See `README.md` for usage, `docs/DESIGN.md` for the design, and `docs/THREAT-MODEL.md` for the threat model. Run `npm test` for the test suite and `npm run demo:bank`, `demo:mailer`, `demo:todo` for the three stories.

## References

- Bernstein, D. J., Duif, N., Lange, T., Schwabe, P., and Yang, B.-Y. (2012). High-speed high-security signatures. *Journal of Cryptographic Engineering*, 2(2), 77-89.
- Crosby, S. A., and Wallach, D. S. (2009). Efficient data structures for tamper-evident logging. *Proc. 18th USENIX Security Symposium*.
- Gray, J. (1978). Notes on data base operating systems. In *Operating Systems: An Advanced Course*, Lecture Notes in Computer Science 60, Springer.
- Laurie, B., Langley, A., and Kasper, E. (2013). Certificate Transparency. RFC 6962, IETF.
- O'Callahan, R., Jones, C., Froyd, N., Huey, K., Noll, A., and Partush, N. (2017). Engineering record and replay for deployability. *Proc. USENIX Annual Technical Conference*.
- Saltzer, J. H., and Schroeder, M. D. (1975). The protection of information in computer systems. *Proceedings of the IEEE*, 63(9), 1278-1308.
- Schneider, F. B. (2000). Enforceable security policies. *ACM Transactions on Information and System Security*, 3(1), 30-50.
- Zeller, A. (2002). Isolating cause-effect chains from computer programs. *Proc. ACM SIGSOFT FSE-10*.
