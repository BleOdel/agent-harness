# Harness architecture

Current implementation includes E0 hardening, E1 adapter/runner contracts, E2 Python support, E3 artifacts/jobs, E4 CPU regression and the initial U0 guide on top of team M0–M6 and durable planning.
Use the [README](README.md) for commands and [threat model](THREAT_MODEL.md) for
security assumptions. These diagrams describe implemented behavior; milestone
reports preserve their original observations.

## Durable planning and handoff

```mermaid
flowchart TD
  E["Check pinned adapter, image, capabilities and frozen skills"] --> U["Operator answers interview"]
  U --> W["Retained workspace: Pi session, decisions, draft PLAN.md"]
  W -->|Resume after exit or timeout| E
  W -->|Operator: plan approve| P["Host snapshot of approved PLAN.md"]
  P --> G["Finite generation reads approved plan and saved session"]
  G --> V["Validate items and unchanged plan identity"]
  V -->|Failure: save diagnosis| G
  V -->|Ready| I["Operator reviews and imports items"]
  I --> F["features.json: tasks plus approved plan context"]
  F --> C["Operator approves task-scoped behaviour checks"]
  C --> B["Ordinary or team builders"]
```

The planner can write only its retained project copy and configured Pi data.
Host approval, proposal hashes and lifecycle state live outside that copy. A
failed document-generation step requires `plan resume`; retries are not dispatched
automatically. No planning artifact directly changes live source. On timeout or
handled termination, contained-process cleanup precedes completion handling.
After an uncatchable controller kill, explicit writer recovery and resume stop
the previous owned container before continuing. Pi's persisted messages survive
independently of whether the model has finished writing its draft.

Implementation: [planning state](src/planning/store.ts), [commands](src/verbs/plan.ts),
[import](src/verbs/add.ts). `verify:planning` exercises deterministic Docker recovery
and the installed Pi session manager without provider calls.

## Guided entry and readiness

`guide` confirms the selected project and derives actions from existing plan,
feature, writer and application state. It has no separate workflow database or
project index. Each prompt releases stdin before a child planning terminal starts.
`project setup` selects the supported adapter and skill bundles; mixed roots need
an explicit choice. Readiness v2 is available through `doctor [--json]`, including
a v1 capability report from image inspection and an isolated runtime probe. It makes no model
calls and distinguishes an authentication file from verified provider access.
The first guide covers planning, item import, check setup, ordinary work and
writer/pending-application recovery. Advanced team work remains explicit.

## Adapter and runner contracts

```mermaid
flowchart TD
  S["Operator project setup / unambiguous Node/Python detection"] --> P["Host-owned project.json v1"]
  P --> A["Installed node-npm@1 or python-pip@1 adapter"]
  P --> R["Installed docker@1 runner"]
  A --> T["Toolchain probe, dependency preparation, source policy, verification recipe"]
  R --> C["Inspect OS, architecture, CPU/RAM and immutable image"]
  T --> I["Accepted execution identity and selected skill hashes"]
  C --> I
  I --> B["Build; verify; integrate; compare approved behaviour"]
  B --> E["Candidate, integration and run evidence"]
  E --> Q{"Resume settings match?"}
  Q -->|Yes| B
  Q -->|No| X["Stop before new dispatch; preserve saved work"]
```

The adapter contract owns detection markers, runtime identity, clean dependency
preparation/installation, source exclusions, shared inputs, verification recipes,
test evidence and build-output declarations. The Node adapter retains existing
npm policies and assertion instrumentation. Python uses a separate wheel/pytest
implementation without the Node counter. A test-only text adapter exercises
the same pipeline without a Node manifest; it is never registered for operators.
Build-output declarations feed explicit `verify --retain` collection into the local
SHA256 store. Manifests bind each output to source and execution identities.

The Docker runner prepares hardened launches, executes finite commands or connects
RPC, inspects capabilities, cancels/cleans owned containers and exports execution
evidence. Verification remains credential-free and offline. Capability requirements
are checks against the fixed runner, not permission grants. No project can load
host adapter code or select an unrestricted host backend.

Execution identity includes the effective project profile, image, operator tool
paths, configured provider/model, test command, install policy, contract paths,
capability report and selected ordinary/planning skill hashes. Timeout ceilings are
operational limits and can be adjusted on resume. Team role skill versions remain
in the accepted inputs and dispatch events. Dependency environment keys additionally
identify candidate manifests/lockfiles and actual runtime versions.

Implementation: [adapter contract](src/adapters/contract.ts),
[Node adapter](src/adapters/node-npm.ts), [runner contract](src/runners/contract.ts),
[Docker runner](src/runners/docker.ts), [execution identity](src/project/execution.ts).

## Python preparation and verification

```mermaid
flowchart TD
  P["pyproject.toml + requirements.lock + exact Python version"] --> V["Validate static metadata and pinned flit backend"]
  V --> D["Input-only preparer: hash-checked PyPI wheels; no source builds"]
  D --> K["Cache inventory + input/image/runtime identity"]
  K --> I["Fresh offline venv; hashed wheel install"]
  I --> B["Build pure-Python project wheel; install it; pip check"]
  B --> W["Disposable builder or fresh verifier"]
  W --> T["Fixed pytest collection; read-only diagnostic reporter"]
  W --> R["Repeat wheel builds; compare bytes"]
  T --> C["Exact source claim and independent review"]
  R --> C
  C --> A["Fresh offline acceptance commands; host compares approved expectations"]
  A --> S["Ordinary apply or team staging/application journal"]
```

Dependency installation is recreated per executable gate and acceptance case.
Candidate test reports are diagnostic: a Python process can fabricate its output,
so only a matching host-side acceptance result permits application. Build outputs
are discarded in source work; E3 retains fresh outputs through `verify --retain`. The adapter contributes fixed container
environment variables so Python commands and console entry points resolve to the
fresh venv in builders and acceptance checks. Project files cannot supply these
harness settings. Python contract-suite declarations are refused until supported.
See [Python policy and migration](PYTHON.md) and [adapter](src/adapters/python-pip.ts).

## Execution and acceptance

Ordinary `work` verifies and applies one item. `team run` stages a batch with one
builder by default, or two with `--max-workers 2`. Only builders overlap; candidate
intake, review and integration are serialized by the host controller. Shared-input
assignments execute exclusively. Neither a model's final answer nor successful
component tests alone advance team prerequisites.

```mermaid
flowchart TD
  T["Accepted features, role profile and contracts"] --> H["Host controller and project writer lock"]
  H --> P["Require approved check coverage before dispatch"]
  P --> EC["Pin adapter, runner and capability identity"]
  EC --> S["Accepted immutable staging baseline"]
  S --> A["Builder A: private container and session"]
  S --> B["Builder B: private container and session"]
  A --> C["Stop worker, capture and validate frozen candidate"]
  B --> C
  C --> G["Fresh offline candidate gates"]
  G --> R["Separate reviewer; source read-only; no skills"]
  R --> M["Three-way merge into current staging proposal"]
  M --> V["Fresh whole-project gates and applicable host contract checks"]
  V -->|Pass| I["Persist proof, integrate and advance prerequisites"]
  I --> S
  M -->|Conflict| F["Record integration failure"]
  V -->|Fail| F
  F --> Q{"Repair remains eligible?"}
  Q -->|Yes| D["Fresh attempt; original role and scope; rejected diff and diagnosis"]
  D --> C
  Q -->|No| X["Stop or block; retain accepted staging"]
  I --> E{"All requested tasks integrated?"}
  E -->|Yes| Z["Staged; live project unchanged"]
  Z -->|Operator runs team apply| AC["Fresh offline cases; host compares output and file bytes"]
  AC --> J["Recheck source and approval; journaled batch application"]
```

Failure at candidate intake, gates or review also refuses acceptance and follows
the task's bounded retry or blocked-outcome policy. Repair repeats building,
candidate gates, review and combined checks; it has no bypass. The default is
one extra integration repair per task under journal versions 3 and 4. It retains the
original role's skills rather than automatically switching to a diagnosis role.

Each proposed integration passes its combined checks before it becomes staging.
There is no separate model-driven final approval phase: `team apply` validates
the retained source, requirements and trusted-check identities and runs the
operator-approved behaviour cases on final staging before writing.
An ordinary run follows the same frozen-candidate boundary but applies its item
without the team's serial merge, staging or batch journal.

Implementation: [controller](src/team/controller.ts), [worker](src/team/worker.ts),
[scheduler](src/team/scheduler.ts), [integration](src/team/integrate.ts).

## Acceptance evidence boundary

```mermaid
flowchart LR
  O["Operator reviews expected behaviour"] --> A["Host approval snapshot and digest"]
  C["Frozen candidate"] --> V["Fresh case copy; offline, credential-free container"]
  V --> X["Stop container; capture output and safe file bytes"]
  A --> H["Host comparison"]
  X --> H
  H --> E["Retain outcome, candidate, approval and execution identities"]
  E -->|Passed and still current| W["Apply or publish application intent"]
```

Expected values and approval state are not mounted by this runner. Steps in a
case share source/data; cases use fresh installations. Assertions reported by
project tests remain diagnostics; a read-only shim and lexical counter make
accidental corruption harder but cannot make a candidate's own report trusted.
Host comparison verifies declared behaviour only, not universal correctness or
resistance to a program tailored to those examples. Approval archives and result
files live under `<project>-harness/acceptance/`, outside writable agent state.
Application validates proof against the current candidate and approved checks;
failed runs retain evidence even though disposable work is removed.

Implementation: [checks and evidence](src/acceptance/checks.ts),
[setup prompts](src/verbs/checks.ts), [readiness](src/guide/readiness.ts).

## Isolation and skills

```mermaid
flowchart LR
  P["Live source and accepted requirements"] --> H["Trusted host snapshots and controller"]
  H --> W["Disposable builder source"]
  K["Accepted role skill manifest"] --> S["Validated, hashed, read-only skill bundle"]
  S --> W
  A["Operator authentication"] --> B["Private builder auth and session"]
  A --> R["Private reviewer auth and session"]
  B --> W
  W -->|Stopped before capture| C["Frozen candidate retained by host"]
  C --> G["Fresh offline verifier copies"]
  C --> V["Read-only reviewer source"]
  R --> V
  N["Credential-free package download container"] --> D["Prepared cache; fresh offline installs"]
  D --> W
  D --> G
  C --> E["Retained evidence and staging"]
```

The diagram's arrows mean host-prepared copies or read-only resources, not shared
writable mounts. Preparation and executable gates have no Pi credentials or skill
mounts; gates run with networking disabled. Builder/reviewer model calls and
package downloads use bridge networking. Model egress is not provider-restricted.
Workers never receive the live repository, another attempt's workspace, controller
state, host control socket or Docker socket.

Team skill manifests validate names, dependencies, interaction modes, tool
requirements and declared resources. Ordinary work/planning freeze role selections from `HARNESS_SKILLS`;
teams freeze declared resources from their accepted profile. All launchers disable implicit skills and
extensions. Reviewers receive no skills. Skill availability, observed read-tool
use and worker-reported workflow evidence are separate facts; none proves the
model followed every instruction.

Implementation: [sandbox arguments](src/containment/sandbox.ts),
[attempt inputs](src/team/inputs.ts), [role profile](profiles/team.json),
[skill assessment](SKILLS_ASSESSMENT.md).

## Live RPC control and cancellation

Team builders and reviewers require Pi **0.80.6**. Docker receives interactive
stdin without a TTY. Bounded UTF-8 JSONL frames and request IDs separate command
responses from lifecycle events. Completion requires valid assistant turns,
`agent_end`, `agent_settled` and a subsequent idle state with an empty queue.

```mermaid
sequenceDiagram
  actor O as Operator terminal
  participant H as Host controller
  participant T as Durable telemetry
  participant P as Builder Pi RPC
  O->>H: team steer attempt-id message (private socket)
  H->>T: Persist request and unique steering ID
  H->>P: steer with request ID and tagged message
  P-->>H: Command acknowledgement
  H->>T: Record acknowledged
  P-->>H: Matching user-message event when consumed
  H->>T: Record delivered
  O->>H: team abort run-id
  H->>H: Prevent new dispatch and acceptance
  H->>T: Persist abort intent
  H->>P: Request cancellation
  H->>H: Discard owned sessions and containers
  H->>T: Reconcile attempts and record aborted
```

Acknowledgement and delivery can arrive in a different order; the diagram shows
a common order. Neither proves compliance with the instruction. Only active
builders accept steering, and uncertain requests are never automatically resent.
The initial abort reply says `abort-requested`; only persisted `aborted` confirms
successful cleanup. Cancellation also covers reviewer and finite-command work.
Pi 0.80.6 lacks `clear_queue`, so the host always destroys the session/container
to discard queued work instead of relying on Pi's abort acknowledgement.

The endpoint is a mode-0600 Unix socket in a mode-0700 temporary directory with
a random capability. The web viewer has no control route. Abrupt controller death
requires explicit dead-writer recovery and resource reconciliation; aborted runs
cannot resume or apply. Accepted staging and audit evidence are retained.

Implementation: [RPC transport](src/agent/rpc.ts), [control](src/team/control.ts),
[owned-container cleanup](src/containment/stop.ts).

## Application, undo and recovery

```mermaid
flowchart TD
  S["Verified staged batch"] --> A["Explicit team apply under writer lock"]
  A --> C["Recheck original live source, requirements, staging and check identities"]
  C --> J["Publish durable intent, snapshots and application pointer"]
  J --> W["Replace source files with per-file progress"]
  W --> F["Mark applied tasks done"]
  F --> R["Append idempotent record and completion event"]
  R --> D["Clear pending pointer; applied"]
  J -. Interruption .-> P["Pending application blocks other mutators"]
  W -. Interruption .-> P
  F -. Interruption .-> P
  R -. Interruption .-> P
  P --> K["Recover exact dead writer if needed"]
  K --> N{"Recovery choice"}
  N -->|Finish| W
  N -->|Rollback before record commit| B["Restore known before-state and retain rollback decision"]
  D -->|Explicit team undo| U["Journal reversal; invalidate acceptance before reverting source"]
  U --> V["Restore prior files; tasks todo; dependents need revalidation"]
```

Recovery compares actual files against retained before/after bytes and refuses
unexpected edits. It can resume any partial stage idempotently; the finish arrow
summarizes that reconciliation rather than unconditionally rewriting all files.
Rollback is refused after the application record is committed; finish recovery
and use undo instead. `team resume` finishes a pending application, but never
implicitly applies newly staged work. With no pending application, `team recover`
only reconciles workers and retained staging.

This is a recoverable sequence of file replacements, not one atomic multi-file
filesystem operation. Cooperating harness writers are excluded; external editors
can still race a final check. Team undo preserves unrelated edits, refuses edits
to batch files and has no redo. Ordinary undo restores raw bytes, merges only supported UTF-8 text and refuses
divergent binary content. Existing hard links and symlink ancestors are refused
in ordinary apply and undo before source writes.

Implementation: [application journal](src/team/apply.ts),
[writer lock](src/workspace/writer-lock.ts), [state reducer](src/team/state.ts).

## Durable state and read-only views

| Location beside the project | Meaning |
|---|---|
| `<project>-harness.writer-lock` | Canonical cooperating-writer ownership |
| `<project>-harness/ml/<id>/approved.json` | Frozen schema, split hashes/IDs, recipe, preprocessing, thresholds and job budget |
| `<project>-harness/ml/<id>/train.json`, `holdout.json` | Host-only approved data; never mounted together into workers |
| `<project>-harness/ml/<id>/state.json`, `evaluation-<hash>.json` | Saved job/model references and host evaluation results |
| `<project>-harness/jobs/<job>/state.json` | Accepted command, identities, bounded events and latest checkpoint reference |
| `<project>-harness/artifacts/manifests/` | Immutable output provenance and references |
| `<project>-harness/artifacts/blobs/` | SHA256 bytes; only unreferenced blobs can be collected |
| `<project>-harness/verify-<id>.json` | Retained verification build environment and input identities |
| `<project>-harness/project.json` | Operator-selected adapter, capabilities and skill names |
| `<project>-harness/executions/<run>/` | Ordinary execution identity and frozen skill resources |
| `<project>-harness/plans/<plan>/execution.json` | Planning execution identity; frozen skills beside it |
| `<project>-harness/teams/<run>/inputs/execution.json` | Team runner/adapter identity; authoritative copy in creation event |
| `<project>-harness/teams/<run>/events/` | Authoritative acceptance and lifecycle events |
| `<project>-harness/teams/<run>/state.json` | Rebuildable acceptance projection |
| `<project>-harness/teams/<run>/telemetry/` | Immutable phases, reported model usage and steering history |
| `<project>-harness/teams/<run>/controller.json` | Host/PID and private endpoint metadata |
| `<project>-harness/teams/<run>/abort.json` | Durable refusal of further execution/application |
| `<project>-harness/teams/<run>/attempts/` | Candidates, proposed integrations and verification evidence |
| `<project>-harness/applications/<application>/` | Immutable intents, source snapshots and application progress |
| `<project>-harness/application.json` | Pointer to a pending application or reversal |
| `<project>-harness/record.jsonl` | Applied, reversed and other ordinary run history |

`team inspect` reads acceptance state. `look` and `view` combine it with telemetry
and retained artifacts, including task roles, prerequisites, phases, gates,
review, repair, integration, elapsed time and reported builder/reviewer spend.
Interrupted reported usage survives resume; missing usage is not inferred and
in-flight calls may exceed dispatch budgets. New version 4 journals bind candidates,
component verification and integration to accepted execution identity. Older records
remain inspect/recover/undo capable; unpinned runs cannot start new dispatch or
application through the CLI. Pending application recovery remains available. Viewer
reads never rebuild state files or start recovery.

## Console implementation and verification

The original S1–S3 console stages (usage capture, browsable history and live
observation) are implemented. Their operating instructions are maintained in
[the README](README.md#reading-what-happened). Static `view` embeds file contents
and historical diffs; `view --serve` adds only the loopback read-only server.
A team-only project is visible before its first applied record. Binary and
oversized files remain listed with an explanation.

Ordinary progress uses a four-second heartbeat; status older than fifteen seconds
or a dead process is shown as stopped. Team liveness uses controller host/PID
metadata. Neither view executes project code, launches a model/container, steals
locks or performs recovery. The server serves only GET `/` and `/status`, polls
once a second from the page, rejects a busy port, and has no control routes.
Display content is escaped; polling updates use text-safe rendering.

Verification references: [usage events](test/events.test.ts),
[static viewer](test/view.test.ts), [live status and server](test/server.test.ts),
[team projections](test/team-status.test.ts), [RPC](test/rpc.test.ts), and
[controller crash recovery](test/team-controller-crash.test.ts).

## Artifact and job lifecycle (E3)

```mermaid
flowchart TD
  O["Operator: saved command, outputs, checkpoint protocol, limits"] --> J["Atomic host job state and bounded event history"]
  J --> P["Frozen source + fresh adapter dependencies; identity pin"]
  P --> R["Offline Docker: readonly prepared input and fixed supervisor"]
  R --> W["512 MiB tmpfs /work; 2 CPUs; 2 GiB RAM; finite execution"]
  W --> C["Bounded regular-file transfer; installed checkpoint validation"]
  C --> A["SHA256 blobs + provenance manifests outside worker mounts"]
  A --> U["Compare source, settings and checkpoint hash before fresh resume"]
  U --> P
  W --> K["Host cancel / supervisor deadline; remove labelled owned resources"]
  V["verify --retain: fresh passing build diagnostics"] --> A
  A --> E["Explicit hash-checked local export; no overwrite or publication"]
  A --> G["Explicit job retirement / reference release; collect only orphan blobs"]
```

The job controller owns source snapshots and accepted declarations in sibling state.
A worker gets a read-only prepared input plus a bounded tmpfs; generated data never
writes into host project source. Fixed transfer code reads bounded regular files;
no worker archive is extracted on the host. Job output is unverified, while retained
verification builds are labelled diagnostics-passed. Neither status is independent
application acceptance or publication. Ordinary and team source application remain
unchanged except for the new source-file size and generated-format refusals.

Reservations charge the full declared attempt allowance before launch, even on early
exit or controller loss. The supervisor enforces a second execution deadline and
keeps tmpfs alive for at most 60 seconds for transfer. The host normally cleans it
sooner. SIGKILL recovery checks saved ownership labels and environment before
removing resources; a compatible checkpoint is required for another attempt.
See [JOBS.md](JOBS.md) for protocol, quotas, retention and operator commands.

## CPU regression and protected evaluation (E4)

```mermaid
flowchart TD
  O["Operator selects external CSV and approves thresholds / training settings"] --> H["Host freezes schema, recipe, seeded split and train-only preprocessing"]
  H --> T["Train rows injected AFTER fresh Python dependency preparation"]
  H --> Y["Protected holdout labels remain in host state"]
  T --> J["E3 offline job: fixed Python -I -S trainer; checkpoint each epoch"]
  J --> C["Host validates checkpoint feature order, preprocessing, parameters and epoch"]
  C --> R["Cancellation / ended-owner recovery; unchanged identities required for resume"]
  R --> T
  J --> M["Inert model JSON retained as unverified artifact"]
  M --> F["Fresh offline Python predictor: model and holdout X only"]
  H -->|Holdout X only| F
  F --> P["Host independently checks numeric predictions"]
  Y --> P
  P --> Q["Compare RMSE ceiling and training-mean baseline; one model hash per approval"]
  Q --> E["Saved report; passing model gets a separate evaluation-passed manifest"]
  E --> X["Checked local export; no overwrite, signing or publication"]
```

The fixed trainer bypasses project imports and Python dependency startup hooks.
No protected labels or ML state directory are mounted during training, dependency
preparation or inference. Recipe source hashes and approval hashes bind jobs;
changed data or settings cannot silently reuse a checkpoint. Evaluation metrics
are host computations, independent of training/project reports. A transient
inference infrastructure failure can retry only the same model. Quality failure
consumes that model's evaluation and retains the failed result.

The guide reads these same saved approvals and jobs; it adds no parallel lifecycle
store. Retirement releases artifact references while retaining host-only data and
audit records. See [ML.md](ML.md) for numerical tolerances, leakage limitations,
retention, the supported CSV/JSON schemas and the exact runnable example.
