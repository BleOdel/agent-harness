# Reliability progress — recovery and active preparation

Completed tasks: hr-001, hr-002, hr-003, hr-004, hr-005, hr-007, hr-008, hr-009, hr-010, hr-011, hr-012, hr-013, hr-014 and hr-018 — **14 of 45**. The remaining 31 tasks are open. Registry completion records defects; it does not solve all of them.

The registry covers all 25 findings: 9 fixed at their documented audit scope, 3 reproduced and 13 inspection-only or partially repaired gaps. F01, F13 and F14 now link current positive regressions and restored-defect controls. Historical audit evidence remains unchanged. Browser timing, noninteractive preparation and peer-review invalidation remain known desired-behavior failures. The full end-to-end reliability program is not complete.

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
