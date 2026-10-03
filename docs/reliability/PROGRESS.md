# Reliability progress — initial implementation

Implemented: hr-002 operational smoke qualification, hr-003 shared capability catalog and hr-007 dashboard authority boundary.

hr-018 is in progress: strict shared interchange record contracts, typed outcomes and pure expected-revision transitions are implemented. Legacy-fixture adapters and concurrent-writer validation remain outstanding; the new contracts do not replace current stores. Operation service migration (hr-024) is not implemented.

hr-001 is in progress: all 25 findings are recorded with code references, original confidence, affected behavior, task owners and expected verification. Three desired-behavior regressions were initially ported into the explicit known-defect lane. Remaining reproductions need to be ported with their associated implementation fixes before hr-001 is complete. They have not been marked fixed.

F09 now has required depth-aware source-selection regressions and a negative control; it is closed at its audited path-exclusion scope. hr-005 remains in progress: bounded high-confidence content scanning and an explicit operator exception workflow are still outstanding. F10 is closed by the dashboard regression and its deliberate guard-removal control. F15 remains open: this batch adds the hosted smoke job and validates its command locally; broader qualification lanes and hosted execution are not asserted. All other findings remain open.

Local validation uses Node 26.5.0 and installed Linux arm64 Docker/Chromium images. It uses no model requests. The Node registry digest was confirmed to include linux/amd64 for the hosted workflow. Actual hosted CI will run only after a later authorized push.

The advisory capability summary is emitted during planning without changing saved planning input digests. No To Be Heard source, approval or retained preparation was modified. The next implementation work is completing baseline regression ports and the execution-preservation / acceptance-recovery chains in the plan.

Final local gate after the source-selection fix: npm run check passed (924 tests: 857 passed, 67 visibly skipped, 0 failures). The separate required Docker/Chromium smoke lane passed all 12 tests with no skips. Six deliberate defect controls were detected and restored; details are retained in evidence/mutation-controls.json. The skipped ordinary lanes do not provide platform qualification.
