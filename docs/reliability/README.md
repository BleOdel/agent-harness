# Reliability implementation

This directory retains the approved roadmap, its implementation status and the audit finding registry. The 45-task program is in progress; this first batch does not claim to solve all 25 findings.

- [Plan](PLAN.md) and [task status](items.json).
- [Finding registry](findings.json): original confidence, trigger, impact, code references, responsible tasks and resolution evidence. An open finding is not waived by a green unit suite.
- [Shared record contracts](STATE-CONTRACTS.md): current ownership and migration boundaries.

Use `harness capabilities` (or `--json`) for implementation scope. Doctor and acceptance planning use the same catalog summary. Catalog support does not mean a runtime is installed or a particular project is verified. Browser/preview dependency limits, incomplete recovery, specialized native/ML recipes and unsupported targets remain explicit.

## Operational qualification

`npm run verify:smoke -- --output /absolute/path/outside/source` requires HARNESS_DOCKER, HARNESS_IMAGE_ID and HARNESS_BROWSER_IMAGE_ID. Image values must be immutable local sha256 IDs. The command does not pull images, contact model providers or publish anything. It creates isolated empty Pi/config directories and runs the asset-helper, Chromium acceptance/capability and staged-preview fixture suites. Missing images, failed tests, required skips, incomplete output and source drift cannot qualify.

Hosted CI prepares the pinned Node and browser runtimes, executes the same command and retains its report and TAP diagnostics. The job runs on push and pull requests with read-only repository permissions, no persisted checkout credential and no model/release secrets. Local evidence is not proof that the hosted job has already run. Browser package versions/lockfile and the multi-platform Node registry digest are pinned; operating-system package downloads during image construction remain an explicitly recorded build input, not a claim of bit-identical image rebuilds.

## Known defects and closing findings

`npm run verify:known-defects` is an explicit, non-qualifying lane. Its tests assert desired safe behavior, so existing known defects fail. Default npm tests list those cases as skipped with a reason; they never count them as fixed. Move each regression into required tests as its implementation task lands. The lane ports preparation-owner selection, browser timing, partial application, provider interruption, mode identity, checkpoint rejection, release retry, noninteractive preparation and peer-review invalidation. The browser test additionally requires HARNESS_VERIFY_BROWSER=1 and the installed immutable browser image configuration; a skipped browser reproduction is unexecuted, never fixed. Nested secret exclusion, dashboard authority and default output capture run as required regressions.

A finding can be marked verified only with a retained positive regression and a deliberately restored-defect control. The registry validates structure and links; it is not a cryptographic proof that an arbitrary linked result is trustworthy. Source/runtime-bound qualification and evidence admission remain separate gates.

## Dashboard boundary

The observer server accepts only its exact `127.0.0.1:<listening-port>` authority. Use the URL printed by the harness; localhost, IPv6 and arbitrary aliases are not configured aliases. Present Origin must match; cross-site or same-site cross-origin browser contexts are refused before private route callbacks run. Framing is denied. This protects the browser-facing local boundary; it does not authenticate against hostile native software already running as the operator. Authenticated mutation controls are a later task, hr-032.

## Source-selection boundary

Source copies, candidate snapshots, retained-source checks, review diffs and dashboard source views use one depth-aware path policy. `.env` and every `.env.*` variant are excluded at any depth except `.env.example`, `.env.sample` and `.env.template`. These examples must contain placeholders. Private configuration directories and files such as `.ssh`, `.aws`, `.npmrc` and `.netrc` are excluded at any depth. Existing generated-directory and operator/adapter exclusions remain in force. Relative excluded paths are announced without reading their values.

Direct application refuses excluded paths. Retained diffs with newly excluded paths are withheld from display; original recovery files remain on disk. New artifacts using excluded paths are refused and old such artifacts cannot be previewed or exported; their retained bytes are preserved. A legacy snapshot whose identity included newly excluded paths is refused for reuse and requires review before fresh preparation. No old snapshot is silently rewritten or upgraded.

This is a filename policy, not a claim to find secrets embedded in ordinary source or approved example files. High-confidence bounded content scanning, explicit exception approval and richer quarantine migration are remaining hr-005 work. Do not place real credentials in sample files. Executable metadata migration remains hr-008 and must cover apply, undo and old receipts together.

## Reading the audit status

Registry version 2 separates four qualification states: `inspection-only` (a documented boundary/gap without a fresh runtime reproduction), `unexecuted` (a regression exists but has not run), `reproduced` (the desired-behavior regression fails), and `fixed` (regression and negative-control evidence accompany closure). Version 1 remains readable without inventing new qualification fields. A fresh run does not overwrite the historical audit baseline.

`evidence/foundation-validation.json` records source-file hashes, the baseline commit, runtime identities, commands and results. `evidence/foundation-known-defects.tap` retains the failing audit run. Its nonzero exit is expected and **does not qualify the harness as passing**. No provider credentials or model requests are used. Nine reproduced findings remain open; the backlog owns their fixes. Inspection-only entries retain a trigger/verification strategy and limitations rather than artificial tests that assert bugs exist.


## Captured output and overflow recovery

All `run()` callers have a combined stdout/stderr default of 8 MiB. Explicit overrides must be finite integers from 1 byte through 64 MiB. Git and verification launchers use this runner too; incomplete Git results and verification reports are refused. Launchers have a 30-minute process timeout. Agent event frames are capped at 1 MiB, retained warning text at 64 KiB, and skill-read metadata at 1,024 entries. RPC framing retains its existing separate bounds. Interactive inherited terminal output and the streaming preview proxy are not accumulated as captured replies.

Overflow produces a non-successful `output-limit` result even if the child happened to exit zero. Diagnostic head/tail text cannot become a completion claim, reviewer verdict or passing gate. On POSIX the runner stops its owned process group; Docker paths additionally require confirmed container cleanup. No process-name matching is used. Windows descendant termination is not qualified by this local evidence.

Ordinary builders stream permitted raw output into exclusive mode-0600 files under the project's harness sidecar, `diagnostics/<run-id>/builder-<attempt>.log`. Each file is bounded by the same 8 MiB quota (at most two builder attempts per ordinary run). These private diagnostics may contain model/tool text; they are not approval evidence. Disk failures also fail closed. Total accumulated sidecar retention across runs remains hr-025.

After confirmed termination, builder overflow saves unverified source before cleanup and records a resume command. Resume runs all gates again. If checkpoint creation fails, or worker shutdown cannot be confirmed, both original source and controller workspace paths are recorded and retained; these are **not** safe checkpoints. Confirm worker termination before inspecting/recovering them. No incomplete work is applied. Other provider-error and cancellation recovery remains hr-009; this change does not claim to fix F05.

`evidence/output-limit-validation.json` records the current F07 qualification; `evidence/output-limit-controls.json` records deliberately restored defects. Historical foundation results remain unchanged. Each fixed finding links its own execution receipt, so later fixes do not retroactively change the original audit run.
