# SwiftUI and AppKit journeys

The native UI lane builds a macOS `.app` inside a disposable offline VM, launches
it and drives its accessibility controls using [Apple’s Accessibility API](https://developer.apple.com/documentation/applicationservices/1460434-axuielementsetattributevalue). It exercises SwiftUI and AppKit notes
fixtures with real keyboard input, Save buttons, restart persistence, validation
messages and app-window screenshots. Use **SwiftUI/AppKit apps** in `harness guide`.

This is a diagnostic workflow. Ordinary source acceptance remains separate, and
passing one journey does not establish correctness of every screen or behaviour.
No application or build script runs on the operator's desktop.

## Start and continue

Prepare the native VM using [NATIVE.md](NATIVE.md), then run:

```sh
harness macos-native validate
harness macos-native doctor
```

Validation builds SwiftUI and AppKit fixtures and checks a deliberately broken
persistence implementation. It uses the installed guest command-line Swift tools;
there is no full Xcode, iOS simulator or additional package dependency installation.
Validation is pinned to the native image and native-UI driver protocol. After
changing either, revalidate and review saved journeys for the new runtime.

In an empty project folder, set `HARNESS_PROJECT` to that folder and choose a
starter:

```sh
harness macos-native init swiftui
# Alternatively, in a different empty folder:
# harness macos-native init appkit
harness macos-native setup
harness guide
```

The guide offers readiness, validation, approving journeys, selecting saved
journeys by title, inspecting results, exporting retained files and recovery.
Saved journeys can be reviewed again after a runtime update without retyping.
To automate these steps, use `approve <journey.json>`, `list`, `verify <check-id>`,
`inspect <run-id>` and `recover <run-id>` after `harness macos-native`.

## Application contract

A journey names a relative `.sh` build entry and relative output `.app` path.
The script runs with its working directory at the copied project root; the starter
uses `build.sh` and `build/Notes.app`. All required tools must already be installed
in the approved guest. The current exercised toolchain is command-line Swift,
SwiftUI and AppKit; arbitrary Xcode projects and downloaded package dependencies
are not established by these fixtures.

Each control needs an accessibility identifier. In SwiftUI use
`.accessibilityIdentifier("note")`; in AppKit use
`control.setAccessibilityIdentifier("note")`. Journey selectors are these plain
identifiers, not CSS selectors, coordinates or visible labels. Input/click/text
steps require a unique match; count steps can observe multiple matches.

Supported steps are fill, press, click, exact text, count, restart and screenshot.
Keyboard keys are Enter, Tab, Space, Escape, ArrowUp and ArrowDown. Text is sampled
for a short bounded period; the host compares those observations with approved
expectations. Restart waits for normal app termination before reopening. A hung
app fails rather than claiming restart persistence. Runs start from fresh VM data;
restarts within one run preserve the app's guest data.

Bounds: one app window, 1–30 steps, 60–600 seconds including compilation and VM
startup, three screenshots, 2,000 accessibility elements, 16 MiB source total and
2 MiB per source file. Native output limits still apply: 4 MiB per retained file,
including the zipped application, and a 64 MiB output volume. Large applications
need a separately designed packaging workflow.

## Guest permissions and evidence

The harness compiles its driver inside each disposable guest. It grants that exact
guest executable Accessibility, screen-capture and input-posting access in the
guest's TCC database. No host privacy grant is requested, and the base VM is not
modified. The tested Tart base already has guest SIP disabled and guest-local
administrator access; the harness does not disable host or guest SIP. The database
schema and OS behaviour are not a portable public API: real validation is required
for every new base. Unsupported permission state fails closed.

Permissions allow the driver to observe the disposable guest. Screenshots select
only the launched app's PID and one window using ScreenCaptureKit. These are not
host-desktop captures. The application and driver share a guest, so a malicious
app can affect evidence; results and exported artifacts remain unverified native
diagnostics, not independent proof against an adversarial builder.

Artifacts include observations, logs, screenshots, a host assessment and `app.zip`.
The starter bundle is ad-hoc signed only inside the guest. Export is not Developer
ID signing, notarisation, App Store distribution or a signed installer.

Records live under `<project>-harness/apple-gui/`. They link to the existing native
runner's owned VM and output volume. The native guardian, offline network boundary,
resource limits and explicit dead-owner recovery apply. A controller interruption
retains state and blocks another run until recovery. Retrying starts a fresh
journey; it does not resume halfway through UI actions.

The validation receipt is `native/apple-boundary.json` under the Harness runtime.
`npm run verify:apple` repeats its real VM fixtures. Portable unit tests validate
approval binding, rejected observations, path/identifier bounds and guided setup;
they do not substitute for the VM fixtures.

## Remaining work

This lane is macOS-only. iOS simulators, Android, Windows and an ML GPU runner are
separate milestones. A Metal compute probe succeeded in the VM, but GPU training,
checkpoint recovery and evaluation are not yet implemented or verified.
