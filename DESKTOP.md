# Linux desktop apps

E6 supplies a bounded Electron workflow: scaffold a notes app, package safe source,
launch the package in offline Docker, exercise approved UI steps, retain logs and
screenshots, and export a package with its runtime descriptor. The existing Node
adapter handles source work, skills, unit tests and operator-approved acceptance.
GUI results are a separate diagnostic record and never apply source changes.

Native support was deferred by the operator on 2026-09-12. There is no macOS or
Windows runner, mobile emulator, host display access, GPU, signed installer or
publication in this release. Linux arm64 was exercised locally; the image recipe
also pins the official x64 archive, but x64 execution needs its own configured run.

## Guided first project

Create an empty directory, then run `harness guide /absolute/path/to/notes`.
Choose **Create a Linux desktop notes app here**, then **Linux desktop apps**.

1. **Prepare the pinned Linux desktop image** downloads the approved tools. This
   explicit preparation needs internet access and Docker disk space; it can take
   several minutes. It uses only the installed harness image recipe.
2. **Check Linux desktop image readiness** probes the image's tools. This is a
   prerequisite check; running an actual journey establishes packaged UI behaviour.
3. **Set up and approve a GUI journey** offers the starter notes journey, short
   prompts for your own selectors/actions, or an existing journey file. Review the
   steps, expected results, time limit and pinned runtime before approving.
4. Select **Verify: Save notes with the keyboard and reopen the app**. Two offline
   packaging passes must produce identical bytes. A fresh container launches the
   packaged app, saves a note with Enter, restarts, checks persistence, rejects a
   blank note and captures the result. The terminal reports each phase and outcome.
5. Select the saved result by title. Inspect it, export a log or screenshot, or
   export the passing package and all its evidence to a new local folder.

The notes app is a starting project with no npm dependencies. `npm test` runs its
storage tests. Use normal `harness plan`, selected skills such as `grill-me`, and
approved source checks to develop it. GUI verification does not call a model.
After changing UI behaviour, review the journey if its approved expectations need
to change. An approval can be rerun on newer source; each run freezes that source.

The happy path requires no JSON edits or copied run IDs. Custom selectors still
require knowledge of the app's UI. An automated terminal journey covers these
steps; human usability and assistive-technology testing remain unmeasured.

## Explicit commands

```bash
harness init --desktop
harness desktop image
harness desktop doctor
harness desktop setup
harness desktop list
harness desktop approve /absolute/path/journey.json
harness desktop verify <journey-id>
harness desktop inspect <run-id>
harness desktop export <run-id> /absolute/path/new-output-folder
harness desktop recover <run-id>
harness desktop release <run-id> --yes
harness artifacts cleanup
```

Only setup and guide require a terminal. Other commands return a nonzero exit code
on failure. Readiness and image preparation do not require provider credentials.
`HARNESS_DOCKER` selects the Docker executable. `HARNESS_DESKTOP_IMAGE_ID` optionally
selects an immutable image ID; otherwise the locally built `harness-desktop:e6` tag
is resolved to an immutable ID before approval. This does not change the ordinary
Node or Python image. A changed runtime or harness GUI protocol requires a new
approval, or restoring the old image.

## Supported journey format

Version 1 has `title`, `timeoutSeconds` (5–300) and 1–30 `steps`, including at least
one text or count expectation. See [the starter journey](examples/desktop-notes/journey.json).

| Action | Fields | Behaviour |
|---|---|---|
| `fill` | `selector`, `value` | Enter text in an input |
| `click` | `selector` | Click one matching element |
| `press` | `selector`, `key` | Enter, Tab, Space, Escape, ArrowUp or ArrowDown |
| `text` | `selector`, `expected` | Exact text must appear in at least one of eight samples, 250 ms apart, after the element becomes visible |
| `count` | `selector`, `expected` | Exact count, 0–1000, after a 500 ms delay |
| `restart` | none | Close and reopen the packaged app, keeping its disposable user data |
| `screenshot` | none | Capture the main window as PNG |

Only one main window is supported. Locator operations have a five-second limit;
launch has a fifteen-second limit, both bounded by the overall GUI deadline.
Text/fill values are limited to 10,000 characters; selectors to 300. Unknown fields,
missing steps, reordered observations, malformed reports and renderer errors fail.
Timeouts and driver failures retain logs; screenshots are retained when the driver
finishes the requested sequence. Reports and screenshots remain untrusted output.

## What gets exported

The output folder contains `app.asar`, `runtime.json`, `observations.json` and the
requested screenshots. The runtime descriptor binds package/report hashes to
source, approval, architecture, image and toolchain identities. Export rechecks
artifact hashes, provenance and host comparisons, and refuses existing targets.
A generic artifact export can still export unverified diagnostics; it does not
promote their status. Retire a desktop run before releasing its artifact references.

This is an **ASAR package requiring an external Linux Electron runtime**, not a
self-contained executable or installer. During verification the harness copies
the pinned runtime inside Docker, replaces `resources/default_app.asar` with
`resources/app.asar`, renames the executable to `harness-app`, and launches it with
no source-directory argument. It checks `app.isPackaged`. The host never extracts
an app archive or starts Electron. Runtime assembly follows Electron's documented
[application distribution layout](https://www.electronjs.org/docs/latest/tutorial/application-distribution).

## Boundaries and recovery

The image uses Node 26.5.0, Electron 44.3.0, Playwright-core 1.63.0 and ASAR 4.3.0.
The base image and Electron archives are pinned by digest; npm tools use a lockfile.
OS package versions are recorded in `/opt/desktop-tools/os-packages.txt`. Apt inputs
can change on rebuild, so only the resulting image ID is treated as immutable.
Xvfb supplies a display inside the container, as described in Electron's
[headless CI guidance](https://www.electronjs.org/docs/latest/tutorial/testing-on-headless-ci).

Containers retain docker@1's non-root user, dropped capabilities, no-new-privileges,
read-only root, 2 CPUs, 2 GiB RAM, 256-process limit, offline network, isolated IPC,
and bounded `/tmp`. No credentials, host display socket or Docker socket are
mounted. Chromium runs with `--no-sandbox` inside this Docker boundary; it adds no
inner sandbox guarantee. The disposable bind-mounted workspace has no independent
disk quota. Source ingestion is capped at 2 MiB/file and 16 MiB total; artifact
retention enforces E3's 32 MiB/file, 64 MiB/batch, 512 MiB/store and 256 manifests.
Large assets, native modules and external npm dependencies are outside this lane.

Expected values and approval state stay outside worker mounts. The driver receives
actions/selectors only and the host compares observations. However, a hostile
Electron main process shares its container with the driver and could forge those
observations. A passing journey therefore means **diagnostics-passed**, not the
independent acceptance required to apply source, and not proof against a malicious
application. A screenshot is review material, not a security attestation.

Each run records its source, stage and owned container before launch. Ctrl-C stops
and removes that container. An internal deadline also bounds the container after
controller loss. After a crash, return to guide, recover the ended writer, then
select the desktop result and recover its resources. Ownership labels, token and
image must match before removal. A cleanup failure remains recoverable and blocks
another desktop run. Rerunning starts a **fresh app from the beginning**; partial
GUI sessions and their user data are not resumable checkpoints. Approvals and
completed evidence survive; temporary runtime/source copies are removed.

## Verification

```bash
harness desktop image
export HARNESS_DESKTOP_IMAGE_ID="$(docker image inspect harness-desktop:e6 --format '{{.Id}}')"
npm run verify:desktop
```

Run this from the harness repository. The configured suite refuses skips and
covers packaged launch, keyboard input, restart persistence, incorrect expectations,
broken storage, screenshots, timeouts, cancellation, controller crash, ownership
checks, protected mounts, checked export and a complete terminal journey. It makes
no provider calls. Plain `npm test` includes unit cases but skips Docker cases when
the desktop image has not been configured; that alone does not verify desktop support.
