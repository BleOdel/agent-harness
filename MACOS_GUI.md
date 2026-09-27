# macOS Electron GUI diagnostics

This lane packages a dependency-free Electron application, launches its macOS
`.app` inside a disposable offline VM, and exercises a short operator-approved
journey. It builds on the [native runner](NATIVE.md). It does not run application
code on the operator’s desktop and does not replace source acceptance.

## Guided use

Choose **macOS GUI apps** in `harness guide`. Prepare the runtime once, then select
**Set up and approve a GUI journey**. Choose the notes starter journey or use short
prompts for input, clicks, keyboard actions, text/count observations, restart and
screenshots. Saved journeys can be selected again for review after a runtime
update, without retyping their steps. Expected results stay on the host. Select a saved journey by title to
run it, inspect the result and export individual retained files.

For a fresh example, create an empty directory and set `HARNESS_PROJECT` to it:

```sh
harness macos init
harness macos setup
harness guide
```

The starter is the same local notes application exercised by the Linux desktop
lane. Its macOS journey includes save, restart persistence, blank-input handling
and a screenshot. This is an Electron app; it does not establish SwiftUI/AppKit,
iOS, Android or Windows compatibility.

Advanced commands:

```sh
harness macos provision
harness macos validate
harness macos doctor
harness macos approve journey.json
harness macos list
harness macos verify <check-id>
harness macos inspect <run-id>
harness macos recover <run-id>
harness macos recover-preparation
```

## Provisioning and trust

The GUI base is `harness-macos-gui` under the Harness Tart directory. Preparation
clones the existing script base and installs Electron 44.3.0 for macOS arm64,
Playwright Core 1.63.0 and ASAR 4.3.0 using the existing desktop lockfile. The
Electron development archive is checked against its official SHA-256; npm
lifecycle scripts are disabled. Tools are transported in an archive so framework
symlinks are recreated inside the guest, not traversed through shared folders.
No project source is part of this installation.

The prepared base is not activated until native boundary fixtures and actual GUI
fixtures pass. The previous script base remains unchanged. Activation changes the
native runtime identity, so old script approvals must be reviewed for the new
base. GUI approvals additionally bind the host/guest GUI protocol. A changed
runtime or protocol cannot silently reuse an old approval.

Each test uses an offline copy with 2 CPUs and 4 GiB RAM, the native guardian,
64 MiB writable output volume and the same ownership/recovery rules as native
scripts. GUI actions, source and driver are copied into the guest; host home,
credentials and expected results are not. No host Accessibility or Screen
Recording grant is requested. The driver captures the Electron app window, not
the operator’s desktop.

## Supported observations and limits

- One app window loaded from the packaged ASAR’s local HTML; dependency-free JavaScript main entry and Node/Electron built-ins.
- A 60–300 second total limit includes VM boot, packaging and UI interaction.
- Up to 30 actions and three screenshots; source is limited to 16 MiB, each file
  to 2 MiB and each retained native output, including the ASAR, to 4 MiB.
- The package is built twice and bytes compared before execution. A temporary
  `.app` is signed ad hoc inside the guest. This is not Developer ID signing or
  notarisation.
- ASAR, observations, logs and screenshots are retained. Exported ASAR still
  needs the pinned macOS Electron runtime; this is not a standalone installer.
- Restart preserves the app’s user-data directory within that VM. Separate runs
  start with fresh data.
- The app and driver share a guest and can influence its observations. Results
  remain diagnostics, not independent proof against a malicious application.
- Root disk growth still has a free-space watchdog rather than a hard quota.

The host compares actual observations with approved expected text/counts. A wrong
expectation, missing observations, lost persistence or failed process cannot pass
solely because the app prints a success message. GUI screenshots still need human
visual review for layout and design quality.

## Recovery and evidence

Run records live under `<project>-harness/macos-gui/`. Each record points to its
native child run; the guided menu offers recovery after the writer ends. The VM’s
independent deadline survives controller termination. Recovery never resumes a
partially executed UI journey; retry uses fresh source and a fresh VM.

Interrupted source-free tool preparation has its own ownership record and
`recover-preparation` command. If preparation finished but validation stopped,
`harness macos validate` reuses the prepared base. Results are retained under the
Harness runtime’s `gui-boundary.json`. `npm run verify:macos` repeats the installed
runtime’s real notes journey and negative controls.
