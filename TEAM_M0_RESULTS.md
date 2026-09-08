# Team M0 — roadmap and verification baseline

Completed and validated locally on 8 September 2026 against `0cc7c34`.
No commit, push or remote workflow run was performed.

## Changes

- Builder, planner and reviewer share explicit-only skill discovery and disabled extension discovery. Configured skills still load through explicit paths.
- The planning command is exercised directly by tests; an alias alone no longer makes it request an absent `grilling` definition.
- `verify:skills` exercises the real Pi 0.80.6 argument parser and resource loader with selected, global and project fixtures plus extension tripwires. A discovery-enabled control proves the extra skills exist.
- All verification commands now load the same operator config files as the CLI.
- `TEAM_PLAN.md` owns future scope, including required assigned-team operation. The original v2 plan remains historical; other follow-up work is deferred explicitly.
- Added a Node 26.5.0 push/PR workflow and a manual, configured Linux-runner verification workflow. They have not been published or run on GitHub.

## Validation

The three regression cases failed against the original behavior before the fix. All 14 focused skill/planning tests then passed, with 45 executed assertions measured by the harness counter.

| Check | Result |
|---|---|
| Typecheck and full unit suite | Passed: 185 passed, zero failed, one Docker-dependent test skipped in the ordinary suite |
| `verify:skills` | Passed against Pi 0.80.6, including extra-global/project-skill discovery control |
| `verify:boundary` | Passed against the real Linux Docker daemon |
| `verify:gates` | Passed: eight tests, zero skips; each deliberate break rejected |
| `verify:reviewer` | Passed: all four measured defects caught, honest control accepted |
| Workflow syntax | Both YAML files parsed; no remote execution claimed |
| Claim and file boundaries | Passed: 20 applicable changes, five criteria accounted for |

The first restricted full run had eight localhost `EPERM` failures. After granting the session network access, every localhost test passed. Docker was initially stopped; it was started and the live checks were then run. Reviewer verification used a temporary private copy of Pi authentication/settings, removed after the check, so it did not share writable session state with the operator. Its dollar spend is not reported by the existing verification command.

The scratch changes were checked before application. The supplied skill definitions and Git history remain unchanged.

Environment recorded for reproducibility:

- Host Node: v26.5.0.
- Host npm: 12.0.1.
- Pi: 0.80.6.
- Container platform: Linux/arm64.
- Configured container: `sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb`.
- Runtime dependencies added: none.

## Remaining scope

Role-specific skill adaptation, structured blocked outcomes, dependency scheduling and team orchestration remain subsequent milestones. M0 does not claim those capabilities exist. The supplied skill definitions are unchanged.
