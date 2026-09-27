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
and recovery after controller loss. Full E5/E6 GUI capability,
mobile, Windows and GPU work remains unimplemented. See NATIVE.md.

First completed implementation slice: browser verification. Available laptop space at
inspection: about 89 GiB; RAM 18 GB, Apple M3 Pro. Avoid installing every SDK or
allocating multiple large VMs before their runner designs are verified.

Browser scope: dependency-free Node HTTP apps in an offline app container;
Chromium and its driver in a second container sharing only the first container's
network namespace. App source never shares the driver's filesystem. Observed UI
checks are diagnostics, not automatic approval of all application requirements.
This does not replace the separately approved source acceptance workflow.
