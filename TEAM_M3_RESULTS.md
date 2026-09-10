# Team M3 — durable controller and isolated assignments

Implemented locally on 9–10 September 2026 against `55efc53`.
This report was prepared before committing or publishing M3.
[M2's GitHub check passed](https://github.com/BleOdel/agent-harness/actions/runs/34370460131).

## Delivered behavior

- `harness team run` executes accepted `features.json` assignments at concurrency one. It verifies and reviews each frozen candidate, then creates a new immutable staging baseline. Prerequisites advance only after that integration. Team execution changes neither live source nor live feature statuses.
- Optional `assignedRole`, `changeScope` and `contracts` survive feature import and status changes. `add` accepts `--role`, repeated `--scope` and repeated `--contract`. A one-role profile supplies a deterministic default; multiple roles require explicit assignments. Paths support exact matches, `*` within a segment, and `**` segments.
- Events record creation, dispatch, submission, verification, integration, terminal attempt outcomes and run stops. Dispatch is committed before process launch. UUIDs identify runs and attempts independently of the historical `rN` counter. Every attempt gets a separate container name, directory, credential copy and Pi session directory.
- Numbered versioned event files are append-only and atomically published after fsync. `state.json` is atomically replaced and can be reconstructed from events. Gaps, unsupported versions, conflicting duplicates and invalid transitions are refused. Duplicate submissions neither advance state nor count usage twice.
- A host closure associates a process result with its assignment. IDs written in worker claims do not select another task or attempt. Intake rechecks frozen source, assigned scope, limits and shared-input policy before verification.
- Retries have distinct identities and receive the prior failure diagnosis. Count, elapsed-time and reported-cost limits prevent new dispatch and record the reason. Finishing the last task at a dispatch ceiling still counts as staged. Incomplete provider/reviewer usage is explicitly an estimate.
- The controller snapshots only role-selected skills and declared dependencies/resources. Available skill digests, successful observed skill reads, and worker-reported workflow evidence remain separate facts. None proves workflow compliance. Reviewer skills remain absent.
- Bundled unattended TDD, core design and diagnosis variants adapt the supplied skill guidance without changing the supplied folder. Interactive skills, missing dependencies/resources, unsupported capabilities, cycles and duplicate names are rejected. Global Pi settings and discovered skills are not copied into private attempt state.
- Team builder and reviewer authentication are separate private copies. Refreshes are not written back to the operator's credential store. Authentication/provider errors are detected even when Pi exits zero; ordinary `work` uses the same execute-and-submit operation and gains that detection.
- A canonical project writer lock covers team, work, sequential run, undo, add/import, init, deps, commit, plan and remove. Lock acquisition atomically publishes a complete owner record; another process or path alias cannot become a writer. An exact token and a dead owner are required for explicit stale-lock recovery.
- `team recover` reconciles owned containers using both run and attempt labels, removes private credential/session copies, checks retained staging, marks unfinished attempts interrupted, and stops the run. It never infers success from a finished process or submitted files. Previously committed staging remains available for inspection.
- Dedicated shared-input changes conservatively invalidate accepted consumers inside staging and revalidate them against the new input version.

## Validation

Behavioral changes had failing tests before implementation. Additional deliberately
broken scope enforcement and provider-error detection were checked against the
regressions, then restored. No assertions were removed or weakened.

| Check | Result |
|---|---|
| `npm run check` | Typecheck passed; 229 tests passed, zero failures, three explicit Docker-suite skips |
| Real Docker `verify:team` | Four tests passed, no skips; includes real controller SIGKILL and CLI checks |
| Real Docker `verify:gates` | Eight tests passed, no skips |
| Real Docker `verify:candidates` | Seven tests passed, no skips |
| `verify:skills` | Pi 0.80.6 accepted exactly the adapted builder/repair bundles; discovery controls passed |

The Docker suite uses image `sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb` on Linux/arm64.

The targeted controller, assignment and state checks include dependency ordering,
role selection, unique retry identities, forged IDs, duplicate handling, event
replay, corrupted journals, scope violations, review refusal, blocked preparation,
budgets, shared-input invalidation and retained-source tampering.

Real Docker `verify:team` exercises serial assignments and the operator CLI,
private authentication/session copies, selected skill mounts, offline credential-free
gates, read-only review, SIGKILL of the controller, exact-token lock recovery and
label-scoped cleanup. A container from another run remains untouched. These are
deterministic process fixtures, not model-generated implementations.

`verify:skills` qualifies the adapted builder and repair bundles against the
installed Pi 0.80.6 loader, including session-directory parsing and exclusion of
global/project skills and extensions. No live model calls or provider spend were
needed for M3's exit checks. M2's live-model authentication limitation has not been
retested as a successful model run.

No runtime dependencies were added. The root dependency lockfile is unchanged.

## Operating limits and next milestone

Team results are staging-only. There is no team live apply, batch undo,
three-way concurrent integration, automatic repair or resume command yet.
M4 adds two-worker integration and its real project demonstration; M5 adds
journaled batch application and resume. Ordinary `work` still applies verified
single-item changes through its existing recovery flow.

The writer lock serializes cooperating harness commands. Editors and other
external writers do not honor it, and ordinary work still has a final
fingerprint-check-to-write race until M5's application journal. A lock held by a
live PID is never reclaimed, including possible PID reuse. Cross-host recovery is
refused. A crash during explicit lock recovery can leave a recovery guard that
requires inspection before manual removal.

Team recovery does not resume dispatch. Candidate source, claims, verification,
review and event evidence are retained; successful cleanup removes worker copies,
cache preparation directories, auth and sessions. Unexpected process/daemon errors
leave an unfinished event for explicit recovery. Abrupt termination can retain
credential copies until that cleanup succeeds. Host-state tampering and a Docker
escape remain outside this controller's trust boundary.

The first script policy and filesystem restrictions from M2 still apply.
Reported spend is a dispatch guard, not a billing cap: a running request can exceed
the remaining budget, and the review protocol does not yet report usage. Per-process
timeouts bound individual invocations; the run time limit stops further dispatch.
Skill manifests attest to declared capabilities and inputs, not the safety or
truth of arbitrary skill prose.
