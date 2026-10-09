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
