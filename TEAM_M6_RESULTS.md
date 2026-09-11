# Team M6 — live control and operational visibility

> Published on `main` in [765d1f1](https://github.com/BleOdel/agent-harness/commit/765d1f1).
> This report preserves evidence from M6; preparation-time publication notes and
> future-milestone limitations below are historical. For current operation, see
> [README.md](README.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

Implemented locally on 11 September 2026 against published M5 commit
`19cad755565e2ca340bda68ed13fe7b60406fbeb`. This report precedes M6 commit
and publication.

## Delivered behavior

- Team builders and independent reviewers use Pi RPC, pinned to tested version
  **0.80.6**. The host correlates command IDs, bounds JSONL records and command
  waits, preserves split UTF-8 and Unicode separators, rejects malformed or
  duplicate responses, and requires successful assistant turns, `agent_end`,
  `agent_settled` and an idle, empty session before inspecting a submission.
  An acknowledgement alone never proves completion.
- `harness team steer <attempt-id> "message"` reaches an active builder through
  a private host Unix socket while the controller retains the project writer
  lock. Workers receive neither the socket nor its capability. Requests,
  acknowledgements, failures and observed delivery have separate durable events.
  Delivery requires the matching user-message event, including a unique steering
  ID. Uncertain requests are not automatically resent.
- `harness team abort <run-id>` prevents further dispatch and acceptance, records
  a durable abort request, cancels running model and finite-command work, and
  reconciles owned containers and private resources before reporting `aborted`.
  Accepted staging remains available for inspection; aborted runs cannot resume
  or apply. The command's initial `abort-requested` reply is not cleanup proof.
- Pi 0.80.6 has no `clear_queue` RPC command. The harness requests cancellation
  and then forcibly discards the process, container and private session, so
  queued work cannot be reused. This is a tested forced-discard strategy, not
  graceful queue clearing.
- `look` and the read-only `view` dashboard display team assignments, roles,
  prerequisites, current phases, gates, review and integration outcomes, repairs,
  elapsed time, steering state and reported builder/reviewer usage. Team-only
  projects are visible before an ordinary work record exists. Persisted events
  reconstruct status after controller death; explicit recovery reconciles the
  dead controller's owned endpoint and unfinished attempts.
- Reviewer usage joins builder usage in team accounting. Persisted live usage
  retains reported spend from interrupted attempts across resume without counting
  completed usage twice. Original dispatch, repair, cost and elapsed-time budgets
  remain in force. No runtime dependencies were added.

## Validation

| Check | Result |
|---|---|
| `npm run check` | Typecheck passed; 265 tests passed, zero failures; nine explicit Docker skips |
| Configured Docker `npm run verify:team` | Ten tests passed, zero skips |
| Configured Docker `npm run verify:gates` | Eight tests passed, zero skips |
| Instrumented RPC/control/abort/crash/status regressions | Eight tests passed; 71 executed assertions counted |
| Dashboard visual check | Synthetic active-team preview inspected in the browser; wrapped status, prerequisites, both usage roles and steering readable |

Behavioral regressions were first run red for missing RPC, control, abort and
status support. Tests cover bounded framing, request correlation and timeouts,
settlement validation, protocol-version refusal, socket permissions/capabilities,
oversized requests, acknowledgement versus delivery, abort during building and
integration, and refusal of late steering, resume and apply. A real child-process
SIGKILL verifies durable status and explicit endpoint recovery.

The configured Docker suite probes the actual installed Pi 0.80.6 process with
`get_state` and `abort`, and verifies that `clear_queue` is unsupported. Full
builder/reviewer scenarios use deterministic RPC fixtures through the production
containment and controller path: steering completes a held builder, both model
roles contribute usage, gates and review stage the result, and abort discards a
fixture that deliberately ignores cancellation. An unrelated container carrying
the same run label but a different attempt identity survives owned cleanup.
Existing containment, combined-check and repair scenarios also pass over RPC.
No new paid or live-model generation calls were used for M6 validation.

The Docker runs exposed an auto-removal race. Cleanup now retries Docker's
"removal already in progress" response with a bounded deadline and treats
already-absent containers as reconciled; other failures remain failures.

## Supported scope and limits

Control is local to the controller's host and uses a private Unix socket; the web
dashboard remains read-only. Steering is limited to active builders and does not
change task scope or acceptance checks. Acknowledgement and delivery do not prove
that the model followed the instruction. Controller death requires explicit
writer-lock and team recovery; status inspection never steals a live lock.

Costs are provider-reported estimates. Missing usage is not inferred, and budget
checks cannot preemptively price an in-flight model call. Cancellation discards
the current session rather than making it resumable. The pinned Pi version is
checked before team execution; changing it requires protocol revalidation.
