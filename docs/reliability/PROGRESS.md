# Reliability progress — Group 1: routine decisions and reusable checks

Completed tasks: hr-001–hr-022 — **22 of 45**. The remaining 23 tasks are open. [Grouped delivery](GROUPS.md) starts next with hr-023–hr-027: common evidence admission and durable execution.

The registry covers all 25 findings: 12 fixed at their documented audit scope, 1 reproduced and 12 inspection-only or partially repaired gaps. F01, F13 and F14 now link current positive regressions and restored-defect controls. Historical audit evidence remains unchanged. Noninteractive preparation remains a known desired-behavior failure. Group 1 fixes dependency-scoped peer-review invalidation; unknown legacy dependencies still require fresh review. Browser timing is now qualified at the documented finite-window scope. The full end-to-end reliability program is not complete.

The lifecycle boundary now includes strict event fields, canonical owner paths, atomic expected-record updates under the project writer lock, concurrent-process tests, retained request reservations and opt-in legacy archives. Legacy inspection preserves original text and cannot produce approval or passing application evidence. No existing project was migrated. Controller adoption and orchestration remain hr-024; common evidence admission remains hr-023; the shared application journal now implements hr-010.

Historical foundation validation in the disposable copy:

- `npm run check`: 938 tests, 863 passed, 75 explicitly skipped, zero failures. A subsequently added artifact-link assertion and the lifecycle/registry tests passed separately (11 tests); TypeScript passed again.
- Required Docker/Chromium smoke: 12 passed, zero skipped. These local Linux arm64 results do not qualify other platforms or assert hosted CI execution.
- Audit reproduction lane: ten failures, zero skipped, all matching recorded findings. These failures are retained rather than counted as passing checks.
- Five deliberate defects in event validation, binding comparison, legacy digest checks, owner canonicalization and registry evidence requirements were detected; all mutations were restored.

Exact commands, runtime identities, source hashes and limitations are in `evidence/foundation-validation.json`; failing audit diagnostics and negative-control results are retained alongside it. No paid model requests were made.

hr-005 now includes bounded content checks and exact-content operator exceptions alongside the filename exclusions. hr-009 and hr-010 now implement failure retention and journalled apply/undo. Acceptance recovery then consumes the shared foundation through its own planned tasks. The 45-task program remains in progress; these foundations do not yet make the entire build workflow autonomous or fully qualified.


hr-004 now bounds shared process capture, Git, verification launchers, agent frames and retained metadata. Overflow never counts as valid evidence. The ordinary builder checkpoints after confirmed stop and can resume through fresh verification; failed snapshots and unconfirmed cleanup preserve the original workspace with an explicit recovery record. Full-suite, installed Docker/Chromium, memory observations and deliberate negative controls are recorded in `evidence/output-limit-validation.json`. This is per-process/per-run qualification; project-wide retention and untested platform cleanup remain separate backlog work. Provider interruption is now covered by hr-009. No model requests or new dependencies were used.

Final hr-004 validation: `npm run check` passed 879 of 953 tests, with 74 explicit skips and zero failures. The required Docker/Chromium smoke passed all 12 tests with zero skips. Seven restored-defect controls failed as intended.


hr-008 adds version-two source identities with a normalized executable bit. Mode-only edits survive candidate capture, team integration, ordinary/staged/team application and undo. Live chmod changes invalidate verification or stop replacement. New recovery snapshots retain both mode and content; old journals can complete their existing recovery under byte-only semantics but cannot authorize a fresh candidate. Known historical executable modes cannot be invented for old ordinary snapshots. Qualification and deliberate negative controls are retained in `evidence/mode-identity-validation.json` and `evidence/mode-identity-controls.json`. No model requests or new dependencies were used.

Final hr-008 validation: `npm run check` passed 891 of 964 tests, with 73 explicit skips and zero failures. The required Docker/Chromium smoke passed 12/12 and isolated Linux mode regressions passed 4/4, both without skips. Five deliberate defects were caught and restored.


hr-005 blocks recognized credential content before source/candidate reuse, scans source-derived prompts and final request text, and withholds unsafe diff/artifact output. Host-owned exceptions permit only exact synthetic fixture bytes in the selected project; they cannot override private paths, export policy or size limits. Legacy files remain retained and blocked for reuse where necessary. Positive regressions, deliberate negative controls, full-suite and Docker/Chromium qualification are recorded in `evidence/secret-selection-validation.json` and `evidence/secret-selection-controls.json`. No model requests or new dependencies were used. Pattern, generated-directory and archive limitations are explicit in the source-selection guide.

Final hr-005 validation: `npm run check` passed 899 of 972 tests, with 73 explicit skips and zero failures. Docker/Chromium smoke passed 12/12 with zero skips. Five deliberate defects were caught and restored.


hr-009 and hr-010 preserve unsuccessful builder work and unify application recovery. Resume is still unverified until every gate passes. Failed capture quarantines the raw workspace; host death leaves an honest pointer and possible-loss warning. New ordinary, staged, team and undo transactions retain modes, feature transitions and history publication under one journal, with legacy recovery preserved. Qualification is recorded in `evidence/recovery-validation.json` and `evidence/recovery-controls.json`. Ten of the 45 tasks are complete; acceptance orchestration and the remaining reliability work are still open.

Validation: `npm run check` passed 940 of 1,011 tests, with 71 explicit skips and no failures. Docker/Chromium smoke passed 12/12 with no skips. Six deliberate defects were detected in a separate disposable copy. No paid model calls or dependencies were added.


hr-011 uses one strict inert JSON checkpoint validator for CPU retention/resume,
evaluation and product evidence. It validates approved model dimensions, float32
weights, Adam state and settings, scheduler progress and learning rate, RNG state,
sampler progress and clustering centroids. Real CPU fixtures and their generator
are retained. Approval hashes include the new validator; old artifacts are kept,
and changed recipes require fresh approval. Eleven of the 45 tasks are complete.
At the hr-011 checkpoint, F13 remained open for promotion/fallback proof.
The hr-012 results below now close that audit defect; broader ML work remains.

Qualification is retained in `evidence/torch-checkpoint-validation.json` and
`evidence/torch-checkpoint-controls.json`. No dependencies or paid model calls
were used. These checks do not qualify GPU/LLM training or prove model quality.

Final hr-011 validation: `npm run check` passed 1,001 of 1,071 tests, with 70 explicit skips and no failures. The CPU qualification passed 70/70 with no skips; Docker/Chromium smoke passed 12/12. Five deliberately broken validators were detected.


hr-012 validates checkpoint candidates and retained bytes before promotion, records explicit older-checkpoint selection without resetting budgets, and preserves honest recovery evidence. hr-013 distinguishes confirmed HTTP rejection from ambiguous GitHub mutations and allows safe retry under the original approval. hr-014 uses operation/phase ownership for saved preparation, repairs generated cases in their original ledger, and reconciles durable retry grants including legacy records.

Validation: `npm run check` passed 1,032 of 1,102 tests, with 70 explicit skips and no failures. CPU qualification passed 76/76 without skips. Docker/Chromium smoke passed 12/12. Seven deliberate defects were caught. Evidence: `evidence/recovery-preparation-validation.json` and `evidence/recovery-preparation-controls.json`. No paid model calls, external releases or dependencies were added. Next dependency-ready acceptance task: hr-015 bounded positive browser observations; hr-016 negative windows follows it. hr-006 credential isolation is also still open.


hr-015 and hr-016 add host-owned eventual positive comparisons and explicit
negative observation windows. The driver streams bounded timestamped samples;
zero requests need a complete interval, observed transient violations remain
failures, and cancellation or timeout cannot count as success. Delayed positive
text/count/attribute/request observations can settle without arbitrary sleeps.
Expected values remain outside the app and driver. Protocol and approval pins
change; old files remain retained and are not silently reapproved.

Evidence and deliberately restored defects are recorded in
`evidence/browser-timing-validation.json` and `evidence/browser-timing-controls.json`.
DOM/storage are sampled, not continuous monitoring; request counts are cumulative.
No claim extends beyond the approved interval. No paid models, new dependencies,
application builds or external publication were used. Next: hr-017 migration of
existing browser checks and approvals; hr-006 credential isolation remains open.

Final hr-015/016 validation: `npm run check` passed 1,039 of 1,110 tests, with 71 explicit optional/known-defect skips and no failures. Browser qualification passed 24/24; required Docker/Chromium smoke passed 13/13, both without skips. Five deliberately restored defects were detected, including the original real Chromium immediate-snapshot regression.


## Credential isolation and saved-check migration

hr-006 routes ordinary building, planning, acceptance preparation, reviewers and team RPC through the selected-provider host-refresh boundary. Workers receive owner-only temporary auth/session directories with no unrelated providers, host settings or OAuth refresh token. Confirmed cleanup removes them. Selected access-token exposure, unrestricted bridge egress and leftovers after abrupt host death remain explicit in THREAT_MODEL.md; this does not claim a credential broker.

hr-017 adds `checks migrate` inventory, bounded independently reviewed draft migration, durable originals and crash-resume checkpoints. Negative windows need an explicit choice; migrated approvals use a separate operator approval action. Staged receipts, retired designs and source remain unchanged. Pending simplification/recipe transactions and standalone browser approvals are reported rather than silently rebased. Broader peer-review invalidation is still hr-022. The live blog inventory found two browser checks requiring window choices; no live project state was edited.

The real smoke lane exposed an atomic browser-frame replacement race. A bounded descriptor reader now retries an unlinked previous frame while refusing actual links and oversized output. Restoring the race fails its regression.

Validation: `npm run check` passed 1,052 of 1,124 tests, with 72 explicit skips and no failures. Credential/Pi/Docker qualification passed 15/15 without skips. Required Docker/Chromium smoke passed 13/13. Seven deliberate defects were detected. Exact identities and limits: `evidence/credential-migration-validation.json` and `evidence/credential-migration-controls.json`. No paid model calls or dependencies were added. Next dependency-ready design work: hr-019 complete evidence feasibility and hr-023 common evidence admission.


## Evidence feasibility foundation (hr-019 remains open)

Preparation now derives stable atomic observation IDs, required controls/results/scopes and capability requirements per criterion before executable generation. Missing anchors are collected together; interrupted discovery resumes from retained criterion replies. Exact contract quotations and supported actions are checked on the host. A changed evidence design invalidates the corresponding interface review, including cached drafts. Ordinary Node/Python route gaps are checked before planner, builder and team dispatch. Runtime installation/qualification gaps remain separate from missing interface choices and human observations.

Validation: `npm run check` passed 1,062 of 1,134 tests, with 72 explicit skips and no failures. Required Docker/Chromium smoke passed 13/13 with no skips. Five deliberate defects were caught. The explicitly authorized two-request GPT-6 Astra high trial completed with 4,552 reported tokens and $0.14032 estimated usage; it identified explanation, validation and expanded-form anchors in one synthetic form. This does not qualify every project or prove minimality of model-discovered anchors.

Evidence: `evidence/evidence-feasibility-validation.json`, `evidence/evidence-feasibility-controls.json` and `evidence/evidence-feasibility-trial.json`. hr-019 is intentionally still open: full desktop/ML target and delivery routing and a retained-author-outline replay remain. Routine interface amendments (hr-020), common evidence admission (hr-023) and controller adoption remain separate tasks. The completed count stays **18 of 45**. No blog state, checks or application source was changed.


## Complete route preflight (hr-019)

The feasibility gate now carries the protected product scope and selected desktop targets into discovery. Ordinary routes check build, verification, apply, recovery, packaging and release capability availability; browser/preview and sensitive-product stages remain explicit. Unsupported npm workspaces stop before planning. Desktop products require selected evidence targets, validated approval hashes and matching installed runtime fingerprints before generation or builder dispatch. Linux inspection uses the journey's exact immutable image rather than the global default. All selected platform failures are collected.

ML product builds stop early because the existing recipe evidence cannot establish application-to-model integration. This is an explicit capability gap, not a removal of standalone CPU/Metal training workflows. Product completion and application evidence still have to be earned. Routine interface amendment recovery remains hr-020.

The retained author outline replay covers eight criteria and 25 browser/manual cases, collecting the known missing category, explanation, validation and expanded-inspection anchors in one saved pass. The deterministic fixture isolates those known gaps; the earlier authorized Astra trial supplies the separately bounded semantic-discovery qualification. No new model request or blog mutation was made.

Validation: `npm run check` passed 1,070 of 1,142 tests, with 72 explicit skips and no failures. Docker/Chromium smoke passed 13/13 with no skips. Installed Linux desktop preflight passed with a deliberately unavailable global default. Six restored defects were detected. Evidence and limitations: `evidence/feasibility-routes-validation.json` and `evidence/feasibility-route-controls.json`. hr-019 is complete at this preflight scope; the plan is **19 of 45** complete. Next: hr-020 routine scoped interface amendments and hr-023 common evidence admission.


Group 1 implements hr-020, hr-021 and hr-022 together. Operator-delegated routine interface amendments are bounded, independently reviewed and resumable. Models can map existing form controls into trusted scenario compilers. Case receipts bind to their actual local mappings and shared requirements; changing shared limitations cannot silently refresh an old verdict. Two synthetic UI variants pass the Chromium scenarios; broken counts, validation, early submission, acknowledgement, notes and prose retention all fail host observations. Seven deliberately restored harness defects are caught separately. Evidence is retained in `evidence/interface-group-validation.json`, `evidence/interface-group-controls.json` and `evidence/form-scenarios-browser.json`. No new dependencies or model requests were used. The live blog was not changed or approved.

Final Group 1 qualification: `npm run check` passed 1,091 of 1,163 tests, with 72 explicit skips and no failures. Required Docker/Chromium smoke passed 13/13 with no skips. The dedicated form lane passed 8 valid scenarios and rejected 6 deliberately defective applications; 7 restored harness defects were caught.
