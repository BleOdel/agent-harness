# Shared lifecycle record contracts

The version-one types and strict readers are in `src/reliability/lifecycle.ts`. They define interchange records; they are not a second database and do not replace current controllers. No stored project was migrated by this batch.

| Concept | Current authority | Migration boundary |
|---|---|---|
| Task | Operator-owned features.json and accepted planning documents | References retain requirement digest; task status remains host-owned. |
| Operation | acceptance/preparation.json, review-progress.json, workflow.json; implementation and team records | Select by task/phase and original bindings. The durable operation service is hr-024; incremental acceptance repair is hr-014. |
| Candidate | workspace snapshots, implementation checkpoints and staging source | Byte-only metadata stays version 1. Mode-aware identity is hr-008; do not invent old executable-bit evidence. |
| Evidence | Existing acceptance, browser, native, ML and product evidence stores | Preserve artifact references and limitations. Shared admission is hr-023. |
| Decision | Operator approvals and candidate-bound stage reviews | Approval purposes stay distinct. Requirement approval cannot become final application or release approval. |

Bindings include task, requirement, source, approval and runtime identities. Unknown kinds/versions and extra/missing fields fail validation. Read-only legacy references pin the original record digest; they neither rewrite legacy bytes nor create passing evidence.

`transitionOperation` is a pure expected-revision transition. A durable caller must load the current record and publish under its existing writer lock with atomic persistence. This function does not claim to provide a filesystem transaction or cross-process lock. Duplicate request reservations are rejected and survive serialize/read/restart. Interrupted operations preserve their reservation history. Attention outcomes require a resolved decision and a newly authorized operation; ordinary start cannot bypass them.

Operation completion requires evidence references. Completing a preparation operation is not task completion or application permission. Record parsing only establishes structure: consumers must resolve and validate evidence/decision purposes and exact bindings before authorizing side effects. That admission policy is hr-023; the operation service is hr-024. Original task or approval changes require an explicit rebase/reapproval, never an in-place binding substitution.

Per-file transaction journals must bind feature-status updates and record publication as well as source writes. Existing incomplete journals must be recovered with their original version before a new writer runs. Implementation checkpoint retention must stop owned workers before final capture and state honestly what was durable after abrupt host loss.

## Storage boundary and legacy preservation

`updateOperationFile` in `src/reliability/compatibility.ts` updates an **already adopted owner file**. It does not create an operation index or discover the active task. The caller supplies the relative owner path, complete previously read operation and event. The adapter canonicalizes the project, acquires the existing project writer lock, compares the complete record (including all bindings), validates the transition, and publishes one atomic, flushed replacement. A missing owner requires an explicit migration. Concurrent cooperative writers cannot both publish from the same revision. A detected external edit before replacement is refused; this is not an operating-system transaction against hostile noncooperating processes.

Events reject extra or missing fields, including an attempted approval substitution on `start`. Reservations persist across pause/restart. Symbolic links within the owner path and multiply linked files are refused. This single-file boundary does not replace the multi-file application journal required by hr-010 or the operation orchestration required by hr-024.

`retainLegacyRecord` is an opt-in, content-addressed archive boundary. It retains the original JSON text, its SHA-256 digest, original format version and owner. Repeating the same import returns the same archive; a corrupt existing archive is refused without replacement. Unknown versions, invalid JSON and missing owner identity/state are rejected before creating archive storage. No source legacy file is rewritten. `readLegacyArchive` checks the envelope and digest again.

Legacy inspection is deliberately weaker than lifecycle admission: it validates the recognizable owner envelope, **not every nested controller field**. The fixtures cover features, preparation, review-progress, implementation, staging and team envelopes. Archives carry `validation: inspection-only` and `authority: legacy-owner`; neither a `passed` word nor an old approval becomes current evidence. A future controller adapter must invoke its own complete legacy reader, resolve original artifacts and approvals, and explicitly adopt its existing owner file before using the new update boundary. No automatic project migration occurs in this batch.

Tests: `test/lifecycle-storage.test.ts` exercises competing Node processes, stale revisions and changed bindings, restart with retained reservations, malformed events, aliases, link refusal, repeated legacy import and corruption. `test/reliability-lifecycle.test.ts` covers the five record types and transition rules. Deliberately removed event validation, binding comparison, archive digest validation and canonical owner resolution all fail these tests; retained controls are in `evidence/foundation-mutation-controls.json`.


## Source identity version 2 (hr-008)

Snapshot `identityVersion: 2` distinguishes mode-aware source manifests from legacy byte-only manifests. Entries are `v2:644:<sha256>` or `v2:755:<sha256>`; the snapshot digest binds the sorted path/entry map. Empty snapshots still require an explicit identity version at admission. New checkpoint baseline/partial records retain this version. Missing versions remain legacy, not implicitly upgraded.

Recovery `CHANGES.json` now records `identityVersion`, `before` and `after` entry maps. Ordinary undo validates recovery files against those maps and merges portable executable changes independently of prose. Legacy records without this metadata retain byte-only recovery semantics. Only existing staged/team application recovery and undo opt into legacy snapshot validation; fresh acceptance, integration, staging and ordinary resume require current identities. New applications now use the shared version-two journal described below.


### Work checkpoints and application intent

Implementation checkpoint v2 adds a classified `failure` with `workerStopped: true`; source is unverified and retains the existing task, baseline, approval and execution binding. Version-one checkpoints remain readable. A separate work-attempt v1 pointer reserves its run identity before dispatch; it records workspace/container locations, not source validity. It can survive host death without claiming an exit handler ran.

Application intent v2 is common to work, staged/team apply and undo. The published pointer pins intent contents; intent pins before/after manifests and the single reserved record. An optional stage/team effect is completed idempotently after source and feature publication. A persisted rollback decision cannot switch direction after another crash. Per-file replacement uses expected content and executable mode; source, features, history and final controller status each have durable recovery boundaries. Completed or rolled-back journals retain originals and reserve their record IDs. Legacy v1 journals finish through their original readers and cannot authorize fresh work.


## Durable execution ownership (hr-024 foundation)

`src/workflow/operations.ts` owns command execution in `operations/current.json`, under the existing canonical project writer lock. It is distinct from the approval-bound lifecycle interchange records: unknown task/source/runtime bindings are not invented. Existing domain controllers remain the authority for their complete phase records until the remaining hr-024 adoption.

Each command reserves a dispatch before its callback. Sequential nested commands inherit one operation; concurrent nested writers are refused. Expected revisions and the complete old owner record are checked before atomic replacement. Status consumers may supply an expected operation ID/revision to `withWriter`; stale requests are rejected before creating another owner. CLI and observer UI display operation IDs and revisions as recorded execution state, not proof of liveness.

`returned` means a callback returned, including callbacks that saved a pause or pending approval. It is never a successful acceptance verdict. `failed` means the command threw. After explicit writer recovery, an unfinished owner becomes `interrupted`; unresolved dispatches are `uncertain`. No model call is replayed or allowance refunded by this service. Old owner records are archived before replacement; existing planning, evidence, continuation, implementation and application-journal bytes remain readable.

Compatibility checkpoints pin saved domain facts by kind, reference and digest. New run/stage/continuation records carry operation IDs; application intents pin the ID before source publication. A replayed intent retains its original history record exactly. These references are progress diagnostics, not a new evidence-admission route. Content approval, source/runtime checks, human observations and final authorization retain their existing gates.

Records are bounded to 1,024 dispatches, 1,024 checkpoints and 2 MiB. Reaching a limit stops rather than silently dropping history. Project-wide retention/pruning remains hr-033. The service is a cooperating host-writer boundary, not protection against arbitrary malicious native code running as the operator.

Remaining hr-024 work: adopt the shared phase/event model as controller authority, consolidate selection/transition APIs beyond command-entry reservations, and qualify crash/restart composition of those phase transitions before declaring the task complete.


### Phase dispatch adoption

The same `operations/current.json` now reserves concrete phase scopes before their callbacks: preparing, repairing, building, verifying, reviewing, staging, applying and recovering. A dispatch may carry `{kind, reference}` phase metadata. This is additive within the execution envelope; old command-only records still parse. New checkpoints name their producing dispatch, and the parser rejects unknown dispatch references. Callers cannot attribute a checkpoint to a different phase.

Ordinary work enters these scopes around builder execution, claim repair, candidate gates, independent review, acceptance execution, stage publication and application intent/commit. Continuation delegates its preparation/review/build callbacks through the same service. Preparation and team commands adapt their existing saved decisions and event journals; team worker scheduling remains inside its existing controller. Staged apply and the internal `application recovery` command also enter the shared dispatcher. Work-attempt pointers retain the operation ID.

Sibling scopes cannot run concurrently on the same inherited operation frame. An accidentally unawaited child holds its parent's writer until it settles; the parent then fails instead of reporting success. A child that has already started is drained, not silently abandoned. Its existing execution timeout remains responsible for bounding it. Finished frames cannot start new phase callbacks. The writer token and complete expected operation record are checked before publishing every reservation.

CLI and dashboard obtain the recorded phase from one projection. `returned` still means only that the callback returned. Pauses, attention, approval and completion remain backed by saved domain records; neither a phase label nor recovery generates evidence or authorization. Journal recovery retains the original intent's operation ID even though a new operation performs recovery.

This is phase-dispatch adoption, not full domain-state consolidation. Preparation selection, continuation allowances and team event reduction still use their compatibility stores. Completing hr-024 requires consolidating those phase-selection/status transitions with explicit migration and reconciliation of old records. Request accounting and retry policy remain hr-026/hr-027.


## Guarded controller state and continuation selection

`src/workflow/state.ts` owns read/compare/write for `continuation.json` and `acceptance/workflow.json`. These files remain the single domain-state authority at their original paths. A read captures the exact bytes, canonical project and record kind in a private in-process expectation. A write requires that expectation (or an absent file), the project writer, an active operation owner, and an unchanged operation record. The expectation is checked again immediately before atomic publication. New revision and operation IDs are host-assigned; a copied stale object cannot silently overwrite a current record.

Legacy version-1 records remain readable without writes. On the first guarded update, their original bytes are retained in `operations/legacy/<kind>-<sha256>.json`; the current file receives revision 1. Subsequent revisions increase without refreshing build, request or recovery allowances. Explicit `continue --renew` archives the old allowance and transfers its expected-state binding to the new allowance. Status reads never renew or migrate anything. Preparation request totals and CLI/dashboard continuation status read through the same validated stores.

State publication precedes the operation checkpoint. If a process dies in between, the domain file is authoritative for its saved counters/status, while operation dispatch remains uncertain. The operator still recovers the dead writer explicitly; no callback is automatically replayed. Digest checkpoints do not prove task completion or permission to apply.

`selectContinuationPhase` prioritizes an existing stage, completed task and blocked requirements before preparation, review or build. A current independently reviewed draft for the selected task goes directly to approval, even when preparation allowance has expired. Source/task/approval/runtime bindings are revalidated; a different task's draft cannot authorize that transition. Review is followed by a fresh domain snapshot before any build. Existing approval and verification gates remain mandatory.

The remaining hr-024 adoption covers preparation's internal phase-selection/status transitions and ordinary-work/team compatibility controllers; this batch does not replace immutable team events or application journals with a status snapshot. End-to-end autonomous recovery and cumulative cost/request policy remain separate tasks.


## Preparation selection and retry compatibility adapter

`workflow/preparation-selection.ts` reads bounded regular phase artifacts and selects the active preparation through the existing operation-sequence/legacy rules. A pending simplification or recipe change takes ownership only when its task/source/base bindings match the active full review. Two pending branches, stale bases or a superseding generation owner are explicit conflicts. A committed migration's cleanup marker remains resumable after the original check has been replaced. Legacy recipe records derive task identity only from their matching retained review.

The returned selection is frozen, belongs to its canonical project and carries a private exact-byte fingerprint. Resume checks that fingerprint under the project writer before invoking the selected adapter. The same selection supplies status and durable retry keys; read-only selection does not rewrite, migrate, approve or discard records. Existing source/task/approval and executable-check validation still run inside the adapters.

`workflow/preparation.ts` owns preparation retry reconciliation and bounded transition policy. A selected phase is saved before dispatch. A changed task/source/operation key after a failure blocks automatic retry; the initial transition from a new request to its first saved owner remains supported. A durable scoped renewal consumes its prior reservation on restart. Existing request and repair limits remain unchanged; approval never follows from a ready status alone.

The host adapter in `acceptance/workflow.ts` retains command compatibility and connects this controller to guarded workflow state, operation phase reservations and existing check operations. Per-check generation/review/simplification artifact writes still use their compatibility implementations; ordinary-work/team domain transitions remain to be consolidated. This does not complete hr-024.
