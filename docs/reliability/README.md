# Reliability implementation

This directory retains the approved roadmap, its implementation status and the audit finding registry. The 45-task program is in progress; this first batch does not claim to solve all 25 findings.

- [Plan](PLAN.md) and [task status](items.json).
- [Finding registry](findings.json): original confidence, trigger, impact, code references, responsible tasks and resolution evidence. An open finding is not waived by a green unit suite.
- [Shared record contracts](STATE-CONTRACTS.md): current ownership and migration boundaries.

Use `harness capabilities` (or `--json`) for implementation scope. Doctor and acceptance planning use the same catalog summary. Catalog support does not mean a runtime is installed or a particular project is verified. Browser/preview dependency limits, incomplete recovery, specialized native/ML recipes and unsupported targets remain explicit.

## Operational qualification

`npm run verify:smoke -- --output /absolute/path/outside/source` requires HARNESS_DOCKER, HARNESS_IMAGE_ID and HARNESS_BROWSER_IMAGE_ID. Image values must be immutable local sha256 IDs. The command does not pull images, contact model providers or publish anything. It creates isolated empty Pi/config directories and runs the asset-helper, Chromium acceptance/capability/timing and staged-preview fixture suites. Missing images, failed tests, required skips, incomplete output and source drift cannot qualify.

Hosted CI prepares the pinned Node and browser runtimes, executes the same command and retains its report and TAP diagnostics. The job runs on push and pull requests with read-only repository permissions, no persisted checkout credential and no model/release secrets. Local evidence is not proof that the hosted job has already run. Browser package versions/lockfile and the multi-platform Node registry digest are pinned; operating-system package downloads during image construction remain an explicitly recorded build input, not a claim of bit-identical image rebuilds.

## Known defects and closing findings

`npm run verify:known-defects` is an explicit, non-qualifying lane. Its tests assert desired safe behavior, so existing known defects fail. Default npm tests list those cases as skipped with a reason; they never count them as fixed. Move each regression into required tests as its implementation task lands. The lane ports preparation-owner selection, browser timing, partial application, provider interruption, checkpoint rejection, release retry, noninteractive preparation and peer-review invalidation. The browser test additionally requires HARNESS_VERIFY_BROWSER=1 and the installed immutable browser image configuration; a skipped browser reproduction is unexecuted, never fixed. Nested secret exclusion, dashboard authority, executable identity and default output capture run as required regressions.

A finding can be marked verified only with a retained positive regression and a deliberately restored-defect control. The registry validates structure and links; it is not a cryptographic proof that an arbitrary linked result is trustworthy. Source/runtime-bound qualification and evidence admission remain separate gates.

## Dashboard boundary

The observer server accepts only its exact `127.0.0.1:<listening-port>` authority. Use the URL printed by the harness; localhost, IPv6 and arbitrary aliases are not configured aliases. Present Origin must match; cross-site or same-site cross-origin browser contexts are refused before private route callbacks run. Framing is denied. This protects the browser-facing local boundary; it does not authenticate against hostile native software already running as the operator. Authenticated mutation controls are a later task, hr-032.

## Source-selection boundary

Source copies, candidate snapshots, retained-source checks, review diffs and dashboard source views use one depth-aware path policy. `.env` and every `.env.*` variant are excluded at any depth except `.env.example`, `.env.sample` and `.env.template`. These examples must contain placeholders. Private configuration directories and files such as `.ssh`, `.aws`, `.npmrc` and `.netrc` are excluded at any depth. Existing generated-directory and operator/adapter exclusions remain in force. Relative excluded paths are announced without reading their values.

Direct application refuses excluded paths. Retained diffs with newly excluded paths are withheld from display; original recovery files remain on disk. New artifacts using excluded paths are refused and old such artifacts cannot be previewed or exported; their retained bytes are preserved. A legacy snapshot whose identity included newly excluded paths is refused for reuse and requires review before fresh preparation. No old snapshot is silently rewritten or upgraded.

hr-005 adds bounded content selection before source copying, snapshot reuse, source-derived prompt reads, agent/check/review dispatch, and diff/artifact display or export. High-confidence private-key headers and recognizable GitHub, OpenAI-style, AWS, Google and Slack token patterns block selection, including in ordinary code, binary bytes and example files. Findings contain rule IDs and paths, never matched values. A content finding blocks the operation rather than silently omitting a source file and turning it into an apparent deletion.

Use `harness source inspect` to see path exclusions and content findings with their file SHA-256. After inspecting a false positive locally, an operator can explicitly authorize the exact synthetic fixture:

```sh
harness source allow test/fixture.txt --sha256 <digest-from-inspection> --reason "Synthetic credential fixture"
harness source revoke test/fixture.txt
```

Exceptions live outside worker source in `<project>-harness/source-policy.json`, under the project writer lock. Each is bound to its relative path and complete content hash, with at most 100 entries. They cannot override private/control path exclusions, file limits or alias restrictions. Worker-written policy files are not authorization. Host writer operations load the selected project's exceptions; direct module callers default to refusing findings unless the host explicitly supplies its policy context. Public views, artifact export and assembled prompts remain screened even when a source fixture is authorized. An exception is consent to expose those exact source bytes to that project's workers, not a recommendation to share real credentials.

Scanning is limited to 32 MiB per file, 128 MiB and 10,000 entries per selected source tree. Oversized or unsafe input stops selection; it never receives a clean result based on a prefix. Artifact input retains its existing 32 MiB limit. Dependency/generated directories omitted by the source policy are not content-scanned by this feature (the legacy sandbox may still copy dependencies for execution). Archives are not unpacked; encoded, encrypted, transformed and unrecognized credentials are not certified safe. This is high-confidence detection, not an entropy scanner, comprehensive DLP, log scrubber or network sandbox.

Old snapshots and artifacts are checked at reuse/display/export, not rewritten. A newly detected finding blocks reuse or hides content while retaining original bytes. Remove the credential from live source, or review an exact false-positive exception, then create and verify a fresh candidate; do not edit an old approval or recovery record to bypass this gate. Revoking an exception also blocks reuse of affected snapshots. Executable metadata remains covered by hr-008 across capture, integration, apply, undo and legacy recovery.

## Reading the audit status

Registry version 2 separates four qualification states: `inspection-only` (a documented boundary/gap without a fresh runtime reproduction), `unexecuted` (a regression exists but has not run), `reproduced` (the desired-behavior regression fails), and `fixed` (regression and negative-control evidence accompany closure). Version 1 remains readable without inventing new qualification fields. A fresh run does not overwrite the historical audit baseline.

`evidence/foundation-validation.json` records source-file hashes, the baseline commit, runtime identities, commands and results. `evidence/foundation-known-defects.tap` retains the failing audit run. Its nonzero exit is expected and **does not qualify the harness as passing**. No provider credentials or model requests are used. Current qualification states are listed in `findings.json`; the backlog owns the remaining fixes. Inspection-only entries retain a trigger/verification strategy and limitations rather than artificial tests that assert bugs exist.


## Captured output and overflow recovery

All `run()` callers have a combined stdout/stderr default of 8 MiB. Explicit overrides must be finite integers from 1 byte through 64 MiB. Git and verification launchers use this runner too; incomplete Git results and verification reports are refused. Launchers have a 30-minute process timeout. Agent event frames are capped at 1 MiB, retained warning text at 64 KiB, and skill-read metadata at 1,024 entries. RPC framing retains its existing separate bounds. Interactive inherited terminal output and the streaming preview proxy are not accumulated as captured replies.

Overflow produces a non-successful `output-limit` result even if the child happened to exit zero. Diagnostic head/tail text cannot become a completion claim, reviewer verdict or passing gate. On POSIX the runner stops its owned process group; Docker paths additionally require confirmed container cleanup. No process-name matching is used. Windows descendant termination is not qualified by this local evidence.

Ordinary builders stream permitted raw output into exclusive mode-0600 files under the project's harness sidecar, `diagnostics/<run-id>/builder-<attempt>.log`. Each file is bounded by the same 8 MiB quota (at most two builder attempts per ordinary run). These private diagnostics may contain model/tool text; they are not approval evidence. Disk failures also fail closed. Total accumulated sidecar retention across runs remains hr-025.

After confirmed termination, builder overflow saves unverified source before cleanup and records a resume command. Resume runs all gates again. If checkpoint creation fails, or worker shutdown cannot be confirmed, both original source and controller workspace paths are recorded and retained; these are **not** safe checkpoints. Confirm worker termination before inspecting/recovering them. No incomplete work is applied. hr-009 extends this path to provider failures, nonzero exits and operator cancellation; see the recovery section below.

`evidence/output-limit-validation.json` records the current F07 qualification; `evidence/output-limit-controls.json` records deliberately restored defects. Historical foundation results remain unchanged. Each fixed finding links its own execution receipt, so later fixes do not retroactively change the original audit run.


## Executable source identity

New snapshots carry `identityVersion: 2`. Each file identity includes its content SHA-256 and portable mode: 0755 when any executable bit is set, otherwise 0644. Snapshot digest comparison, frozen copy validation, build-change detection, candidate review and evidence binding use that identity. Setuid, setgid and sticky bits on source files are refused. Ownership, timestamps, ACLs and non-executable read/write permission differences are not portable source semantics. Copies and delivery normalize modes; this is not a complete permission-preserving backup tool.

Mode-only edits appear in change sets and reviewer/retained diff output. Ordinary, staged and team application deliver the verified executable bit; undo restores it. Replacement checks detect live mode drift, including a chmod made while the atomic replacement is being prepared. A merged team candidate combines nonconflicting content and executable changes rather than dropping the mode change.

Old records remain readable. Byte-only snapshots and implementation checkpoints cannot authorize fresh work or inherit mode-aware evidence. Retained source remains available for explicit recovery and fresh verification. An already-started legacy team or staged journal can complete its existing intent using its recorded byte checks and original permission policy; that recovery is not upgraded evidence. Legacy ordinary undo keeps its byte-based merge behavior and preserves the current mode where available, defaulting restored missing files to 0644 because the historical executable bit was not recorded. New undo records capture the modes actually observed and written.

This does not make a sequence of file replacements atomic. hr-010 adds a shared durable recovery journal, described below. Local macOS and installed Linux-container results do not qualify Windows ACL behavior or native/mobile runners.


## Implementation and application recovery (hr-009 / hr-010)

A stopped builder's unsuccessful exit saves a version-two unverified checkpoint before cleanup, including failure classification, source manifests and task/approval/execution bindings. Authentication, quota, network, nonzero exit, timeout, output-limit and operator cancellation follow this path. Resume creates a fresh sandbox and reruns verification. Existing version-one checkpoints remain readable. If content is unsafe or capture fails, the raw workspace is quarantined and the previous checkpoint stays available; no successful capture is claimed.

Before dispatch the host writes an attempt reference under `implementation/attempts/`. `harness look` reports unfinished references, source/controller paths, container identity and the previous checkpoint. SIGKILL cannot execute a final capture: confirm worker termination and recover the dead writer before inspecting raw source. Unsaved work may be lost; the reference is not a validated checkpoint and is never auto-imported.

All new source applications and undo writes use version-two `application.json` plus `applications/<id>/intent.json`, durable before/after snapshots, portable modes, per-file progress, feature-status bytes and a reserved history record. Ordinary undo still supports three-way conflict handling and undo-of-undo. Team undo retains its conservative conflict policy; team redo remains unsupported. `harness recover-application` finishes the saved intent; `--rollback` persistently selects reversal before record commitment. After commitment finish recovery, then undo. Recovery refuses unrelated bytes, mode, requirements or product changes. A rollback does not erase a committed record or authorize a new build. Staged recovery still validates final operator review and current acceptance evidence. New writers are blocked while any current or legacy journal is pending.

Legacy team journals use `harness team recover <id>` and legacy staged journals use `harness stage apply <id>`. New staged and team journals also retain these entry points. Snapshot paths are selected from each run's transaction ID; older ordinary `recovery/<run>` directories remain readable. No live project state is migrated by installing this version.

The proof covers local controller behavior and the installed Linux runtime, not whole-filesystem atomicity, physical power loss, remote filesystems, Windows ACLs or all native runners. Qualification, failure injection and restored negative controls are in `evidence/recovery-validation.json` and `evidence/recovery-controls.json`.

## PyTorch checkpoint integrity (hr-011)

Training admission, resume, evaluation and evidence collection now share the same
inert JSON validator, bound to the approved recipe and data dimensions. Real
classifier and clustering fixtures are retained with their generator. The
collected regression rejects null tensors, empty Adam state, wrong shapes and
dtypes, nonfinite values, incorrect scheduler/settings, invalid RNG structures,
and inconsistent sampler progress. The old F13 reproduction now runs in the
default suite.

The task-level qualification is recorded in `evidence/torch-checkpoint-validation.json`.
The subsequent hr-012 qualification covers promotion and explicit fallback.
Broader ML qualification remains hr-042. This change makes no CUDA, Metal or LLM
checkpoint claim. Old approvals and source artifacts remain intact; a changed
recipe hash prevents reusing their approval for this new validator.


## Active acceptance preparation (hr-014)

New generation and full-review checkpoints embed a shared operation ID and an
increasing sequence. Selection uses that identity, task/source bindings and phase;
changing an old file's timestamp cannot make it the current operation. Full review
supersedes generation only within the same operation. Conflicting identities at
the same sequence stop for inspection. Existing files are not eagerly rewritten;
legacy incremental generation with its own ledger remains repairable, and older
minimal records retain the historical timestamp adapter until a new checkpoint.

Targeted repair now reads `preparation.json`'s `state.reviewLedger` during generation
or the complete review record's ledger during review. A failed generated case is
repaired in place, retaining successful peers and later ungenerated obligations.
The workflow reconciles a saved retry reservation with that same owner before any
new dispatch. Authentication and provider interruption retain the reservation;
they do not silently grant another repair epoch. Input-bound legacy workflow grants
are carried forward when an operation ID is introduced, preserving already-spent retries.

`harness checks status` reports the active task, phase, check, source file and
operation. Bounded preparation also saves this structured `nextAction` in
`acceptance/workflow.json`. It is guidance, not approval or application evidence.
Final operator approval is still separate. Broader orchestration, migration,
review-invalidation and browser timing tasks remain on the roadmap.


## Browser timing qualification

hr-015/016 implement default bounded eventual positives and explicitly approved
negative windows. The host compares timestamped observations; interrupted or
incomplete windows fail. Real Chromium and restored-defect evidence live in
`evidence/browser-timing-validation.json` and `evidence/browser-timing-controls.json`.
See [browser semantics](../../BROWSER.md#bounded-asynchronous-observations) for
sampling limits, deadlines and retained evidence. F02 is fixed at this scope;
existing-check migration is available through `checks migrate`; broader end-to-end qualification remains open.


## Saved-check migration and credentials

The hr-006/hr-017 batch is qualified in [credential-migration-validation.json](evidence/credential-migration-validation.json). All contained Pi lanes select one provider and keep refresh credentials on the host. Migration reports current check/helper versions together, retains original bytes, reviews compatible changes within a bounded allowance and leaves approval explicit. Historical runs cannot acquire new observation semantics. See the README migration commands and THREAT_MODEL.md for retained-credential and pending-transaction limits.


## Early evidence feasibility

Ordinary preparation now records unapproved atomic observations in `acceptance/evidence-planning.json` and a digest-bound `evidence-design.json` after feasibility succeeds. Each criterion has retained provider replies, stable observation IDs, exact proposed-contract anchors, evidence kind and needed capabilities. Missing controls, validation feedback and inspection scopes are reported together before executable generation. Known unsupported ordinary Node/Python routes stop before model dispatch; absent installations and unqualified runtimes are separate diagnoses. A digest change invalidates interface-review reuse. Human observations remain pending even when automated design is feasible.

hr-019 now includes selected desktop approval/runtime checks and deterministic refusal of ML application completion where integration evidence is unsupported. This is preflight capability admission, not passing desktop/ML application evidence. Linux desktop checks use the selected immutable image, independently of the global default. Discovery uses the existing explicit request/time allowance, saves completed criteria, and allows one bounded format correction. Its output is not approval or runtime application evidence. Missing routine interface choices remain retained for the scoped amendment work in hr-020. Qualification and the authorized synthetic trial are in `evidence/evidence-feasibility-validation.json`.


The product scope participates in the evidence fingerprint. Missing desktop selections, changed approval/runtime pins, unsupported workspace layouts and absent product integration providers stop before the relevant dispatch. Existing artifact release support stays bounded by its documented provenance limitations; preflight does not authorize a release. Current qualification is in `evidence/feasibility-routes-validation.json`; macOS GUI execution and broader ML application integration are separate qualification tasks.

## Routine choices, form scenarios and scoped review (Group 1)

[Delivery groups](GROUPS.md) sequence the remaining approved work. Group 1 implements hr-020, hr-021 and hr-022; autonomous operation ownership and common evidence admission follow in Group 2.

An operator can delegate narrow choices once for a task with `harness checks choices <task-id>` and revoke them with `harness checks choices <task-id> --revoke`. The confirmation describes accessible names/control types and splits of unapproved observations. The record is bound to the task requirements and stored outside application source. Existing projects receive no inferred delegation. This does not approve a check or an application, authorize more requests, or permit changes to an already approved task's evidence.

When feasibility or a browser design reports a contract-choice or journey-limit blocker, preparation can propose a typed, bounded amendment under that delegation. It retains the old/proposed outline, reason and model replies, then independently reviews preservation of meaning, privacy, scope and evidence sufficiency. At most two amendments are adopted per preparation, within the enclosing request/time allowance. A malformed reply has one format correction. A provider interruption preserves the reply/checkpoint without consuming a usable correction. Missing browser actions stop for a capability fix. A changed requirement or disputed proposal returns a concrete human decision; no automatic manual/HTTP substitution or approval occurs.

Typed accessible mappings are local to their named browser observations. Original free-text/inherited contract paragraphs remain global dependencies. Case review receipts include stable clause/obligation references, exact case inputs, relevant mappings, coverage limitations and runner semantics. The global outline/coverage receipt is separate. Changing a peer description or a different local control mapping retains independent case receipts; shared privacy changes invalidate dependants. Changing a shared coverage limitation also invalidates its cases. Missing legacy dependency bindings require re-review rather than copying a new fingerprint onto an old verdict. Invalidated receipts and generated source are retained. Free-text clauses are deliberately conservative: the harness does not guess that a privacy rule is irrelevant.

Common browser designs may now supply data-only form scenarios. Trusted code compiles text limits/live counts, acknowledgements, optional content notes and failed-submission prose retention into ordinary bounded Chromium journeys. Models map approved controls and fixture data; they do not generate the repeated interaction mechanics. Compilation is not approval, execution or complete criterion coverage. Independent review still checks that the compiled observations cover the selected behaviour.

The templates support native text/select controls and explicit preview/error observations, with a 16 KiB scenario and 60-step journey ceiling. Text-limit scenarios check one ASCII field (minimum at least 2, maximum at least 3 and below 12,000), typing/paste/delete counts without reload, then empty/minimum/maximum boundaries with either rejection or truncation. Other valid fields use bounded setup interactions. Content-note scenarios check supplied categories; exact option enumeration and forbidden-control inventory remain separate obligations. Failure retention compares actual visible input values, including captured values, on the host over a finite 500 ms interval. Request-absence windows are 300 ms, not a guarantee of permanent absence. Larger, custom or unsupported interactions require a supported ordinary journey or an explicit blocker. Visual quality and assistive technology remain separate evidence.

The `value` browser observation adds host comparison of current form-control values; generated driver actions never receive expected values. Browser protocol/capability identity changes require affected old approvals to go through the existing migration/review path. Existing blog source, approvals and saved history are not modified by installing this batch. Tests use synthetic forms and provider replies; no live-model result or end-to-end blog completion is claimed.


## Evidence admission

`src/evidence/admission.ts` evaluates separate design, automated, source-review, manual and authorization facts against current host requirements. `acceptance.ts` and `delivery.ts` adapt retained records by exact artifact references. The envelope is computed at the admission boundary; the existing acceptance, run and stage records remain the durable owners. It is not a second approval store.

Ordinary and staged application and shared-journal recovery use the policy. Team/worktree adapters are tested but their complete delivery integration remains hr-030. An automated-only result cannot satisfy a manual requirement or final authorization. Ordinary explicit work keeps its existing automatic-application semantics; staged delivery requires final operator observations and approval.

New receipts pin the complete acceptance and source-review artifacts. Command stdout beyond the existing 4,000-character preview is retained as a separate bounded, private `acceptance/results/*-output-*.txt` artifact and read back by its hash. Candidate processes cannot see these receipts. Retention across all runs remains a separate task. Browser admission continues to re-assess the retained journey artifact.

Older receipts are read without rewriting them or inventing missing observations. Full hashed previews can supply text evidence; truncated previews, missing runtime identities, or source-review packets without a current approved-contract binding require fresh verification/review. Artifact hashes protect against changes relative to the retained host reference; they are not signatures against hostile software running as the operator. Original limitations and human-attestation labels remain visible in admission results.
