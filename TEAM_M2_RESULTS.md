# Team M2 — frozen candidates and clean verification

> Published on `main` in [55efc53](https://github.com/BleOdel/agent-harness/commit/55efc53).
> This report preserves evidence from M2; preparation-time publication notes and
> future-milestone limitations below are historical. For current operation, see
> [README.md](README.md) and [ARCHITECTURE.md](ARCHITECTURE.md).

Implemented locally on 9 September 2026 against `e5a185a`.
This report was prepared before committing or publishing M2.
[M1's GitHub check passed](https://github.com/BleOdel/agent-harness/actions/runs/34336562374).

## Delivered behavior

- Work starts from a host-owned baseline, including source and requirements identities. The worker receives a separate copy. Live edits never enter the candidate comparison.
- Every container launcher used by work, review and gates confirms removal after exit or timeout. Worker output is captured only after its container has stopped.
- Candidate intake rejects symlinks/special files, unsafe paths, excessive scope and unauthorized dependency/contract changes. Frozen source and controller manifests stay outside worker-writable directories.
- Package preparation receives fixed manifests and no model credentials, Pi package or skills. Artifact downloads disable installation scripts. A fresh offline installation proves the cache, and every executable verifier gets its own source/cache copy and fresh offline install.
- Environment identities include package and lock bytes, immutable image, measured container Node/npm/platform/architecture, exact installation arguments and script policy. Missing artifacts and mismatched or unsupported inputs stop as `environment-blocked`. Failed candidate preparation never borrows the baseline environment's identity as proof.
- Default script policy denies installation hooks, checking lock metadata and actual unpacked package manifests. Explicitly allowed scripts run only in offline installation/proof containers and cannot change candidate source.
- Tests may create disposable files, but those files cannot affect another verifier or application. Review mounts frozen source read-only and receives no skills. Application uses frozen candidate bytes after checking candidate and live baseline identities.
- `harness add ... --shared-inputs` creates a dedicated assignment for package/contract changes. Ordinary assignments become blocked change requests. Accepted shared-input changes produce new version identities and conservatively invalidate other completed tasks.
- Records and `<project>-harness/candidates/<run>/attempt-N.json` retain baseline, candidate and environment identities. Existing records remain readable. `look` and `view` expose environment-blocked results.
- Added `verify:candidates`, plus the configured manual workflow step and operator documentation.

## Validation

Behavioral checks were demonstrated red before their fixes, including live
source overwrite, verifier writes entering acceptance, unauthorized shared
inputs, missing installation-script metadata, and stale environment identity
on failed candidate preparation. The new snapshot and dependency APIs had
failing tests before their implementation.

| Check | Result |
|---|---|
| `npm run check` | Typecheck passed; 213 tests passed, zero failures, two expected Docker-suite skips |
| Real Docker `verify:gates` | Eight tests passed, no skips |
| Real Docker `verify:candidates` | Seven tests passed, no skips |
| Worker dependency tampering | The corrupted worker dependency made broken code pass in that worker; clean verification rejected the same source |
| Verifier isolation | A test rewrote source and created a file; a separate build still saw original candidate source, and neither edit entered application |
| Installation failures | Manifest/lock mismatch and an empty prepared cache stopped acceptance |
| Script policy | Denied hooks were refused; explicitly allowed hooks ran offline; hooks that changed source were refused |
| Timeout | A timed-out Docker writer was removed before capture continued |
| Command-level checks | Live edits survived a refused apply; ordinary shared-input edits blocked; dedicated updates invalidated completed consumers; failed preparation recorded no successful environment identity |
| Boundary checks | Verifiers/preparation mount only their disposable directory; review mounts source read-only without skills |

The real Docker fixtures use the pinned `is-number@7.0.0` artifact and its
committed integrity value. They require no model authentication. The normal
unit suite skips the two Docker suites explicitly; verification commands
refuse to count skipped suites as successful verification.

Environment: host Node 26.5.0, npm 12.0.1, Pi 0.80.6; Docker Linux/arm64,
image `sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb`.
No runtime dependencies were added and the supplied skills were not changed.

## Live-model check limitation

A separate real builder/reviewer smoke fixture could not reach successful
model-driven application. Pi returned `No API key for provider: openai-codex`
inside its JSON event stream, with zero model tokens reported. The builder
made no changes and the failing fixture test prevented application. A second
attempt with raw event capture confirmed the authentication error. Temporary
credential/settings copies were removed after both attempts.

This is not counted as a successful live-model check. Configured Pi
authentication must be restored before repeating it. Pi currently exits zero
for this error, and the existing event renderer does not surface it directly;
work therefore diagnoses the unchanged failing test. Improving that provider
error reporting remains follow-up work, separate from M2's verification proof.

## Supported scope and remaining work

The initial dependency policy supports one package root, npm lockfile v2/v3,
and integrity-pinned HTTPS artifacts. Workspaces, Git/local/linked inputs and
shrinkwrap files stop explicitly. Installation flags are restricted and
included in the environment identity. Cache preparation is per run; there is
no shared persistent cache or concurrent candidate controller yet.

Source snapshots support regular files under the existing exclusion policy.
Generated directories and worker dependencies are excluded. Checks compare
source bytes and requirements; they are not a multi-writer transaction or an
executable-mode tracking system. An external write after the final live check
remains a race. Writer locking and journaled source/status application belong
to M5. Shared-input invalidation is deliberately conservative until assignment
ownership exists.

M3 is next: durable controller state and isolated assignments, with
concurrency one first.
