# Noninteractive workflow commands (hr-025)

The CLI and interactive guide dispatch preparation, selected-check repair,
continuation and status through `src/workflow/commands.ts`. This adapter uses
the existing durable operation service and domain controllers. It does not
replace approval, verification, application or recovery rules.

## Commands

```sh
harness checks prepare author-experience --max-requests 3 --max-seconds 600 --request-seconds 180 --json
harness checks repair check-id --task author-experience --max-requests 2 --max-seconds 600 --json
harness continue author-experience --max-requests 3 --max-seconds 600 --max-builds 1 --json
harness status --json
harness checks status --json
harness continue status --json
```

Preparation also accepts `--task <task-id>` instead of a positional task.
If omitted, the saved active task is reused; otherwise task selection is a
pending decision. Repair targets a case in the active saved preparation;
optional `--task` asserts ownership, it does not switch that preparation.
Continuation retains its existing task and allowance argument validation.

These commands work with ordinary pipes, closed stdin and redirected stdout.
`--json` implies noninteractive input and writes newline-delimited JSON (NDJSON),
one event per line. It does not emit an enclosing JSON array. Without this flag,
output is plain text; non-TTY input or output disables questions. Use
`--non-interactive` to disable questions even in a terminal. Missing information
returns a decision rather than consuming stdin. Flags must appear only once.

The existing default preparation allowance is 12 requests, 600 seconds total,
180 seconds per request; explicit repair now uses the same bounded allowance
and retains its spend under `acceptance/repair-runs/`. These are request/time
limits, not dollar caps. Cumulative accounting across invocations remains
hr-026. Continuation build dispatches retain their existing build/gate timeouts.
No model request is made by status. No command in this protocol approves checks.

## Event envelope

```json
{"version":1,"invocationId":"UUID","sequence":1,"command":"prepare","project":"/absolute/project","type":"started","data":{"approvalImplied":false}}
```

`sequence` starts at 1 and increases within one invocation. Consumers should
ignore unknown data members/event types within version 1. An event may include
`operationId` when it belongs to a durable operation. Invocation IDs identify a
single command call; operation IDs identify retained work across calls.

| Type | Data and meaning |
| --- | --- |
| `started` | Invocation began; no approval implied. |
| `progress` | Human-readable `text` (chunks up to 8,000 characters), or task and allowance selection. Progress is not a stable text-parsing API. |
| `dispatch` | Durable operation reservation, including dispatch ID, command and phase; emitted after reservation and before work. |
| `checkpoint` | Durable checkpoint metadata, emitted after the saved checkpoint. |
| `allowance` | Request reservation count, configured limits and remaining milliseconds. |
| `usage` | Provider-reported spend and `complete`; missing usage is not zero cost. |
| `status` | Reconciled state fingerprint, optional next action and operation identity/revision/state. Read-only, not permission to perform a stale action. |
| `decision` | `question` and `choices`, each with an ID, label and optional suggested command. |
| `terminal` | Outcome, process exit code, message and optional pending decision. |

A handled command ends with exactly one terminal event. Late callbacks cannot
emit after it. Abrupt process death, a broken output pipe or an unrecoverable
runtime failure can truncate the stream; absence of terminal means unknown,
never success. Inspect retained state with `harness status --json` before
resuming. Events are live notifications, not a replay log or recovery authority.
The durable journal, domain checkpoints and exact approval/evidence records
remain authoritative. Output can contain project paths and model progress;
consumers must handle it as project data.

## Stable terminal outcomes

| Outcome | Exit | Meaning |
| --- | ---: | --- |
| `success` | 0 | Requested action completed. A status read or selected repair success does not mean the application is complete or approved. |
| `paused_allowance` | 2 | Request/time/build allowance reached; retained progress can resume under a new allowance. |
| `decision_required` | 3 | Missing input, contract choice, approval or operator recovery needs attention. Review the supplied choices. |
| `capability_failure` | 4 | Required execution/evidence capability is unavailable. |
| `provider_failure` | 5 | Provider authentication, quota, transport, timeout or unusable output interrupted a model request. |
| `failed` | 1 | Invalid invocation or another unclassified failure. |

Preparation reaching a ready draft returns `decision_required` with a review
command, because approval is separate. Exact case, task and interface review
rules remain enforced. Choice IDs are display identifiers, not authorization
tokens: there is no generic automated approval or answer-replay endpoint.
Use the specified task/allowance flags or the existing explicit review flow.

## Boundaries and qualification

The shared API covers these four operation families. Planning interviews,
setup/review dialogs, other platform commands and dashboard mutation are not
converted by this change. The guide remains an interactive menu; its matching
commands use the same API and dialogue abstraction rather than a separate
workflow implementation. Dashboard controls remain hr-031/hr-032/hr-037.

Qualification uses public CLI subprocesses with closed stdin and redirected
stdout, API tests, retained repair fixtures and actual installed Linux Docker
with deterministic local Pi replies. It makes no real provider requests and
does not modify or approve the blog. See
[evidence/noninteractive-validation.json](evidence/noninteractive-validation.json)
and [evidence/noninteractive-controls.json](evidence/noninteractive-controls.json).
