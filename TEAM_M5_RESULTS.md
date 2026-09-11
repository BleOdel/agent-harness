# Team M5 — repair, resume and journaled application

> Published on `main` in [19cad75](https://github.com/BleOdel/agent-harness/commit/19cad75).
> This report preserves evidence from M5; preparation-time publication notes and
> future-milestone limitations below are historical. For current operation, see
> [README.md](README.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

Implemented locally on 11 September 2026 against published M4 commit
`b949856d667259a3fc53e570fb19efbdd45cffc9`. This report precedes M5 commit
and publication. [M4's GitHub check passed](https://github.com/BleOdel/agent-harness/actions/runs/34562846250).

## Delivered behavior

- New version 3 team runs allow one automatic integration repair by default; `--max-repairs 0` disables it. Repairs receive the original role/scope, current accepted staging, failed candidate diff and specific failure. They produce fresh candidates and must pass candidate gates, independent review and combined checks. A second failure blocks dependent dispatch. Version 2 journals retain their original retry semantics; version 1 remains inspect/recover only.
- `harness team resume <run-id>` reconciles owned containers and private resources, marks unfinished attempts interrupted, validates live source/requirements and retained staging, then restarts only eligible work. Accepted integrations survive. Interrupted repairs retain their original failure context with a fresh attempt identity. Original dispatch, cost, wall-clock and repair budgets remain in force, including downtime. Already-applied and undone batches never relaunch builders.
- `harness team apply <run-id>` explicitly applies a completed verified batch. It rechecks original live source and feature fingerprints under the canonical project writer lock, verifies staging and frozen checks, then publishes a durable application intent before writing source. Apply, undo and recovery of a pending application need no Docker or model configuration.
- Application state lives beside the project under `applications/application-<uuid>/`, with immutable intent and before/after source snapshots, source modes, before/after feature text, intended record and progress evidence. The durable `application.json` pointer blocks other mutators until recovery or completion. Temporary source replacements live in the external journal on the same filesystem.
- `team recover <run-id>` completes a pending application; `--rollback` restores its before state while no application record is committed. The rollback decision is durable across further interruptions. `team resume` also finishes an already-pending transaction; it never automatically applies newly staged work. Recovery uses actual before/after fingerprints rather than trusting a progress marker. Unexpected source or feature bytes refuse overwrite and retain evidence for manual recovery.
- Source bytes are flushed before feature tasks become `done`. Idempotent record and completion-event handling prevents duplicate application history after a crash. The record remains content-append-only; batch completion atomically replaces the JSONL file with its exact previous prefix plus one record.
- `team undo <run-id>` and ordinary `undo <batch-record-id>` use a journaled batch reversal. They invalidate task acceptance before changing source, restore the batch's prior files, mark its tasks `todo` and transitively invalidate completed/doing dependents. Unrelated edits survive; changes to batch files require manual reconciliation. Team batch redo is explicitly unsupported. Existing ordinary single-item undo semantics remain available.
- `show` and `view` read the retained batch before/after snapshots. README commands and the roadmap now describe M5 and identify M6 as the next milestone.

## Validation

| Check | Result |
|---|---|
| `npm run check` | Typecheck passed; 257 tests passed, zero failures; six explicit Docker skips |
| Configured Docker `npm run verify:team` | Seven tests passed, zero skips |
| Application and resume regressions | Sixteen tests passed, including real child-process SIGKILL at seven boundaries |
| Instrumented application/resume/concurrency regressions | 20 tests passed; 229 executed assertions counted |
| Retained M4 issue-tracker lifecycle | Batch applied as `r1`, applied resume did not dispatch, batch undone as `r2`; original source hashes and task statuses restored |
| Preserved applied issue-tracker snapshot | `npm test`: nine tests passed, zero failures, after undo |

Regression tests first failed for missing application/resume support. Further
negative runs caught rollback direction changing after interruption, a live edit
during intent preparation, a file/feature edit during replacement preparation,
and lost executable permissions. Fixes were verified without disabling checks.
The full suite exposed a sleep-based ordering assumption in an existing parallel
builder test; explicit completion barriers now preserve its exact ordering and
overlap assertions independently of machine load.

Crash coverage includes intent publication before the first write, prepared
replacement before rename, rename before progress, all source writes before
feature updates, feature update before record, record before completion event,
and completion event before pointer removal. Recovery produces one record and
never marks a partially written batch done. Additional tests cover rollback
interruption, interrupted undo rollback followed by retry, binary additions,
file deletion, executable creation/restoration, feature drift, symlinks,
external edits, dependent invalidation and cooperating-writer exclusion.

The Docker repair fixture deliberately writes output that passes component tests
but fails a host-owned integration check. Its repair receives the rejected diff,
changes the output and passes fresh component, review and combined-check phases.
The Pi process and reviewer responses are deterministic fixtures; this validates
the production containment/controller path without claiming a new live-model
repair demonstration. No new model calls were used for M5 validation.

## Existing real-model artifact

M5 exercised the actual version 2 M4 team run
`team-52598f3e-a99f-40d6-80eb-1576c2a26633`, whose three assignments were produced
and reviewed by real Pi models in M4. Applying it created six files in one batch
and recorded final source digest
`ecc77f723d27ef2fa1bf26a4f65330bea8c5e7010e136cc1834cac879f3005e9`.
Resume returned its applied state without launching work. Undo restored original
digest `b7c6218262ccc00603a8a92e2fa2976e88c8f929b67338e08bbbc175098b9c49`,
kept the accepted contract `done`, and returned API/client/integration to `todo`.
The preserved applied snapshot subsequently passed all nine project tests,
including real HTTP create/read, invalid input and persistence after restart.
The demo's current state is `undone`; both application records and snapshots
remain available.

## Supported scope and limits

Regular text/binary additions, modifications and deletions are supported. Existing
file permissions are retained; new files preserve staging permissions, including
executable bits. Excluded secrets, dependencies and control files remain outside
source application. Symlinks, special files, touched hardlinks, file/directory
replacement and cross-filesystem destinations are refused. Metadata-only changes,
ownership and extended attributes are not fingerprinted. Empty directories may
remain after deletion.

A journal makes interrupted multi-file writes recoverable; it cannot make them
one atomic filesystem operation. Fingerprint checks refuse observed external
edits, but an external editor can still race the final check and replacement.
Recovery intentionally stops on unexpected bytes instead of overwriting them.
The journal covers team batches; ordinary single-item application keeps its
existing failure semantics. Cost accounting remains an estimate and excludes
unreported reviewer usage. M6 live control/RPC and operational visibility remain
pending. No runtime dependencies were added.
