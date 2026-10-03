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

`npm run verify:known-defects` is an explicit, non-qualifying lane. Its tests assert desired safe behavior, so existing known defects fail. Default npm tests list those cases as skipped with a reason; they never count them as fixed. Move each regression into required tests as its implementation task lands. The known-defect lane currently ports mode identity and incomplete checkpoint rejection. Nested secret exclusion now runs as a required regression; the other reproductions remain in the audit record until ported with their associated fixes.

A finding can be marked verified only with a retained positive regression and a deliberately restored-defect control. The registry validates structure and links; it is not a cryptographic proof that an arbitrary linked result is trustworthy. Source/runtime-bound qualification and evidence admission remain separate gates.

## Dashboard boundary

The observer server accepts only its exact `127.0.0.1:<listening-port>` authority. Use the URL printed by the harness; localhost, IPv6 and arbitrary aliases are not configured aliases. Present Origin must match; cross-site or same-site cross-origin browser contexts are refused before private route callbacks run. Framing is denied. This protects the browser-facing local boundary; it does not authenticate against hostile native software already running as the operator. Authenticated mutation controls are a later task, hr-032.

## Source-selection boundary

Source copies, candidate snapshots, retained-source checks, review diffs and dashboard source views use one depth-aware path policy. `.env` and every `.env.*` variant are excluded at any depth except `.env.example`, `.env.sample` and `.env.template`. These examples must contain placeholders. Private configuration directories and files such as `.ssh`, `.aws`, `.npmrc` and `.netrc` are excluded at any depth. Existing generated-directory and operator/adapter exclusions remain in force. Relative excluded paths are announced without reading their values.

Direct application refuses excluded paths. Retained diffs with newly excluded paths are withheld from display; original recovery files remain on disk. New artifacts using excluded paths are refused and old such artifacts cannot be previewed or exported; their retained bytes are preserved. A legacy snapshot whose identity included newly excluded paths is refused for reuse and requires review before fresh preparation. No old snapshot is silently rewritten or upgraded.

This is a filename policy, not a claim to find secrets embedded in ordinary source or approved example files. High-confidence bounded content scanning, explicit exception approval and richer quarantine migration are remaining hr-005 work. Do not place real credentials in sample files. Executable metadata migration remains hr-008 and must cover apply, undo and old receipts together.
