# Team M1 — prerequisites and blocked work

> Published on `main` in [e5a185a](https://github.com/BleOdel/agent-harness/commit/e5a185a).
> This report preserves evidence from M1; preparation-time publication notes and
> future-milestone limitations below are historical. For current operation, see
> [README.md](README.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

Implemented and validated locally on 8 September 2026 against `17c0177`.
M1 is not committed or published. M0 is published on `main`; its follow-up
[GitHub check passed](https://github.com/BleOdel/agent-harness/actions/runs/34283035346).

## Behavior

- Automatic work chooses eligible items in MoSCoW order; explicit work with unfinished prerequisites stops before sandbox creation or agent launch.
- Feature validation rejects missing references, self-dependencies and cycles with readable paths. Waiting work is distinguished from an empty backlog.
- Builders can submit `outcome: "blocked"` with a nonempty reason and requested input. The host records the outcome, updates task status and discards partial edits without review or application. Legacy completion claims still work.
- Accepted prerequisite changes and undo invalidate downstream acceptance transitively, preserving code and history. Items marked `needs-revalidation` require gates and fresh review, including when no files change. Restoring a prerequisite does not restore downstream acceptance.
- Explicit retries of blocked items can complete without cosmetic edits, provided gates and review pass. `look` and `view` show blocked input and waiting prerequisites, and prioritize current invalidation status over old applied records.
- Repeated undo follows the original task through the reversal chain instead of targeting an `undo rN` label on the third reversal.

## Evidence

Behavioral tests were written and run before implementation. The dependency
suite failed four cases against the old behavior. The command-flow suite
failed six cases before wiring M1 into execution. The unchanged blocked-retry
case also failed before its fix. The new submission suite initially failed
because its production module did not yet exist.

| Check | Result |
|---|---|
| `npm run check` | Typecheck passed; 200 tests passed, zero failed, one Docker-dependent test skipped |
| Focused dependency/submission/command-flow suite | 15 tests passed |
| Real Docker `verify:gates` | All eight tests passed with no skips; deliberate broken changes were rejected |
| Real Pi blocked-work fixture | Returned blocked, requested the missing deployment region, recorded zero changes/gates and no review; sandbox removed |
| Command-flow fixture | Partial builder edits never reached the project; malformed blocked output never reached review or apply; revalidation review refusal preserved invalidation |
| Undo fixture | Accepted prerequisite rerun invalidated two downstream levels; three successive reversals preserved their invalidation and restored the expected source bytes |
| Operator views | CLI surfaced requested input; HTML escaped it and displayed waiting prerequisites |

The command-flow tests substitute only the Docker/Pi process boundary. They
exercise the production selector, sandbox lifecycle, gates, records, apply,
undo and views. The substituted gate process runs a real Node test using the
real assertion counter; it does not fabricate an assertion count.

The live Pi fixture used `openai-codex` / `gpt-5.6-sol` and reported 2,679 tokens,
two turns and $0.012187. It used temporary private copies of authentication
and settings, removed after verification. No reviewer was launched because
the builder was blocked. The source project remained unchanged.

Environment: Node 26.5.0, npm 12.0.1, Pi 0.80.6, Linux/arm64 Docker image
`sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb`.
No runtime dependencies were added. Supplied skill definitions are unchanged.

## Limits and next milestone

Invalidation covers changes accepted or undone by the harness. Arbitrary
outside edits and concurrent source changes require M2's immutable baseline
checks. Source writes, run recording and feature statuses retain the existing
failure semantics; M5 adds a recoverable application journal. No team workers,
role-specific skill policy or concurrent controller is introduced in M1.

M2 is next: immutable baselines and isolated verification inputs.
