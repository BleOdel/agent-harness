# Deferred capabilities — implementation sequence

The operator authorised implementation and laptop dependency installation on
2026-09-27. This reopens the deferred roadmap; it does not declare support before
its evidence exists. No automatic external publication is authorised.

1. Browser UI verification: isolated real Chromium, approved short journeys,
   host comparison, viewport/keyboard/screenshots/accessibility diagnostics,
   bounded cancellation/recovery, saved artifacts and guided setup.
2. Native platform isolation: inspect and provision an isolated macOS runner;
   define and verify a Windows runner separately. Do not launch model-generated
   project commands unrestricted on the operator's laptop.
3. Mobile: Android toolchain/emulator first; iOS simulator on a verified macOS
   lane. Xcode is present, but Java/Android tooling is missing. Installation and
   sample build/launch/persistence evidence are separate completion conditions.
4. GPU: select a supported isolated GPU runner and validate training/checkpoint/
   resume/evaluation. Apple Metal hardware is present; it is not an NVIDIA/CUDA
   backend and its presence alone does not establish contained GPU execution.
5. External release: GitHub Releases selected by the operator; draft releases first. Add credential
   separation, artifact binding, dry run, upload/outcome reconciliation, and
   concrete publication approval. Existing local staging remains supported.

Browser verification is implemented and tested with the installed image. GitHub
Releases delivery is implemented with simulated transport tests; no remote artifact
has been uploaded or published. It works with GitHub Free without hosted Actions.
A first native macOS script lane is implemented and verified on the laptop:
disposable offline Tart VMs, Swift compilation, host comparison, timeout cleanup
and recovery after controller loss. A packaged macOS Electron GUI lane adds keyboard interaction, restart persistence,
validation messages, screenshots and host comparisons. A separate SwiftUI/AppKit lane now adds accessibility-identifier journeys, keyboard
input, restart persistence and screenshots. It exercises command-line Swift builds,
not arbitrary Xcode projects. Mobile, Windows and arbitrary GPU frameworks remain unimplemented; fixed Metal regression is documented below.
See NATIVE.md, MACOS_GUI.md and MACOS_NATIVE.md.

First completed implementation slice: browser verification. Available laptop space at
inspection: about 89 GiB; RAM 18 GB, Apple M3 Pro. Avoid installing every SDK or
allocating multiple large VMs before their runner designs are verified.

Browser scope: dependency-free Node HTTP apps in an offline app container;
Chromium and its driver in a second container sharing only the first container's
network namespace. App source never shares the driver's filesystem. Observed UI
checks are diagnostics, not automatic approval of all application requirements.
This does not replace the separately approved source acceptance workflow.

Infrastructure still required for later milestones:

- Android: choose and verify an emulator-capable isolated runner before SDK/image
  installation. The current macOS guest has no validated emulator acceleration.
  [Android acceleration requirements](https://developer.android.com/studio/run/emulator-acceleration)
  do not establish support inside the current VM.
- iOS: the guest needs a pinned Xcode/simulator image and sufficient storage; the
  host Xcode installation alone is not simulator verification.
- Windows: an appropriate licensed image or an existing Windows runner must be
  selected. No Windows subscription or VM has been purchased.
- GPU: the fixed Metal recipe now has a separate execution and recovery lane.
  General frameworks and dedicated GPU quotas still need separate evidence.

The operator selected a MacBook-first route: SwiftUI/AppKit, then a Metal GPU
runner, then iOS. Android and Windows need separate runner selection. A real Metal
compute probe first returned correct doubled values on the guest Apple Paravirtual
device; the separate training and recovery trial below now exercises the ML recipe. The guest
reports kern.hv_support=0; no Android emulator acceleration is claimed. About
55 GiB host space remained before this native UI milestone. No paid cloud machines
or hosted Actions runners were provisioned.

## Metal numeric training delivered

The first [Metal lane](METAL.md) uses the Mac VM for fixed float32 regression,
validated segment checkpoints, owned interruption recovery and host-only holdout
evaluation. Its synthetic trial compares uninterrupted and recovered training.
This closes the narrow Mac GPU training/recovery slice; arbitrary GPU frameworks,
large models, distributed work, CUDA and exclusive GPU quotas remain deferred.
