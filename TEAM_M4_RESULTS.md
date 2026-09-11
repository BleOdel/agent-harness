# Team M4 — concurrent builders and verified integration

Implemented locally on 10 September 2026 against `a74c639` (published M3).
This report precedes M4 commit and publication.
[M3's GitHub check passed](https://github.com/BleOdel/agent-harness/actions/runs/34515445019).

## Delivered behavior

- `harness team run --max-workers 2` overlaps independent finite Pi builders. Shared-input assignments remain exclusive. Dispatches are durable before launch; the controller binds results to host-issued identities and drains already-running attempts at dispatch/budget limits.
- Candidate intake and review remain isolated. The controller serializes three-way merges using each candidate's original baseline and current accepted staging. It preserves independent edits and refuses conflicting content, delete/modify and file/directory collisions, binary conflicts, and stale contract or dependency inputs, including nested manifests.
- Every proposed integration runs complete project checks and all currently applicable host contract checks against fresh verification copies and clean dependencies. Rejected integration does not advance staging or prerequisites. Retries receive the failure diagnosis and start from current staging.
- Trusted check manifests declare IDs, profile-relative resources, argument-vector commands and prerequisite task IDs. Only declared resources are frozen. The journal's creation event binds the verification configuration digest; checks validate source digests and mount read-only, with no credentials, skills or network.
- Root package scripts and the test command are frozen at creation. Verifier copies restore those scripts, including typecheck/build and npm pre/post hooks; changing candidate scripts cannot remove a selected gate. Candidate source remains unchanged.
- New version 2 journals require a durable `integration-verified` record tying the current staging digest, candidate digest, proposed source and passing gate evidence together before `integrated` can advance staging. Version 1 history remains readable and recoverable; it cannot silently restart under parallel semantics.
- Provider/model defaults can resolve from the host Pi settings when role and harness values are absent. Only those two settings keys are read, and resolved role settings are frozen; global settings are never copied into workers.
- `builder.json` retains host-observed invocation intervals, provider/model, usage and unique container/session paths. Private authentication, sessions and mutable worker copies are removed on completion. Unexpected controller errors reconcile every owned in-flight attempt before returning, leaving unfinished journal entries for explicit recovery.
- Added a reproducible issue-tracker seed, accepted contract/profile, trusted HTTP/persistence check and explicit `npm run demo:team -- /absolute/new-directory` entry point. It uses the adapted TDD and design skills with real Pi models.

## Real Pi exit demonstration

Run `team-52598f3e-a99f-40d6-80eb-1576c2a26633` completed with Pi 0.80.6,
`openai-codex` / `gpt-5.6-sol`, using Linux/arm64 Docker image
`sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb`.

| Assignment | Host invocation start (UTC) | Finish (UTC) | Reported tokens |
|---|---|---|---:|
| API / persistence | 19:58:19.761 | 19:59:47.888 | 48,433 |
| Client | 19:58:19.762 | 19:59:24.437 | 43,381 |
| Final integration | 20:00:06.856 | 20:01:20.787 | 42,095 |

The API and client launch intervals overlapped for **64.675 seconds**. They used
distinct UUID container names, private auth/session directories and the same
baseline digest `b7c6218262ccc00603a8a92e2fa2976e88c8f929b67338e08bbbc175098b9c49`.
Both reported real provider usage and completed successfully. The client integrated
first; the API's three-way merge retained it. The final assignment then received
both accepted implementations.

All three candidates passed project gates and independent real Pi review. Final
combined verification passed **58 project assertions across four collected test
files**, plus **19 host contract assertions** covering real HTTP create/list/get,
invalid input, missing IDs, and persistence after closing and recreating the server.
Final source digest:
`ecc77f723d27ef2fa1bf26a4f65330bea8c5e7010e136cc1834cac879f3005e9`.

The original live source and feature manifest still match their captured fingerprints.
No containers with the run label remain. Private builder/reviewer auth, sessions,
worker directories and prepared builder environments were removed.

Successful-run reported builder usage: **133,909 tokens / $0.50936**. Reviewer
usage is unavailable in the current review protocol, so this is not a total bill.
An earlier fixture attempt used unrecognized `.mjs` test names; the collection
gate correctly rejected it and staging never advanced. That run was stopped,
the fixture now materializes `.test.mjs` names, and the successful run started
fresh. The earlier run reported another $0.511646; interrupted/unreported and
reviewer usage may add to that. A small provider probe reported $0.00524.

## Validation

Initial regressions failed for absent merge support, serial builder execution,
and acceptance without combined verification. New merge regressions also failed
for file/directory collisions before implementation. Deliberately removing script
pinning makes the Docker regression fail; restored code passes it. Assertions
and collection checks were retained.

Final validation on 11 September 2026:

| Check | Result |
|---|---|
| `npm run check` | Typecheck passed; 241 tests passed, zero failures, five explicit Docker-suite skips |
| Configured Docker `npm run verify:team` | Six tests passed, no skips; includes controller SIGKILL, integration rejection and script pinning |
| Configured Docker `npm run verify:gates` | Eight tests passed, no skips |
| Real Pi issue-tracker run | Three assignments staged; 64.675-second API/client overlap; final 58 project + 19 contract assertions |

The final configured checks use the same pinned Docker image as the real demo.
The initial final-check attempt after continuing the task was denied access to
Docker and local HTTP listeners by the turn sandbox. Granting network permission
and rerunning the checks produced the passing results above.

The Docker negative fixture deliberately returns `{item: issue}` from creation
while the client expects a direct issue. Both isolated component suites pass;
review is explicitly stubbed in this deterministic fixture so the test isolates
the integration decision.
The combined host contract fails, staging retains exactly the earlier accepted
integration, and the final dependent assignment never launches. A compatible
variant completes all three assignments. Other tests cover exclusive shared-input
work, budget draining, cleanup on transport errors, immutable check resources,
version-1 compatibility and forged/missing integration proof rejection.

No runtime dependencies were added. The root dependency lockfile is unchanged.

## Remaining scope

M4 retains team output in staging. M5 owns integration repair, restart/resume,
journaled batch application and batch undo. Cost limits prevent new dispatch;
already-running requests and unreported reviewer usage can exceed the estimate.
The writer lock governs cooperating harness processes, not external editors.
