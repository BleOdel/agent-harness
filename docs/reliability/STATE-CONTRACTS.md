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
