# Native macOS script diagnostics

The first native lane runs an approved `.sh` build/test script inside a disposable
macOS VM on an Apple Silicon Mac. A Swift command-line fixture exercises the real
compiler. This is a foundation for native platforms, not native GUI, mobile,
Windows or GPU support. Ordinary `harness work` still uses its configured Docker
runner; this diagnostic lane does not silently change that boundary.

## Guided use

Choose **Native macOS checks** in `harness guide`:

1. **Prepare and verify the macOS base VM** installs a checksum-verified Tart
   release and downloads a macOS image if missing. It needs host Xcode command-line
   tools, APFS cloning and substantial disk space (at least 65 GiB free recommended
   before download). Initial provisioning and its real VM verification take time.
2. **Check native readiness** validates the pinned runtime and base identity.
3. **Set up a native script check** asks for a relative `.sh` entry, exact expected
   output, time limit including VM boot, and optional output files. Review and
   approve those expectations. They stay on the host.
4. Select the check by title. Inspect the saved observations and artifact IDs.
   Source is copied; the original application is never modified or launched on
   the laptop. No model request is made.

```bash
harness native provision
harness native doctor
harness native revalidate  # after a runner update; requires new check approval
harness native setup
harness native list
harness native verify <native-check-id>
harness native inspect <native-run-id>
harness native recover <native-run-id>
```

`native approve <file>` accepts a reviewed JSON check. It contains `version: 1`,
`title`, relative `.sh` `entry`, `timeoutSeconds` (10–600), `expectedExit`, exact
`stdout`, and `artifacts` (up to eight relative files). The script runs from a
writable guest copy of the project. Dependencies must already exist in the frozen
VM; there is no network installation during verification. Swift and shell scripts
are the first exercised workload. A new toolchain needs new image evidence.

## Isolation and resource ownership

Tart 2.39.0 and the base disk/config/NVRAM are pinned. The official Tart archive
checksum and application signature are verified on installation. Preparation boots
only the trusted base with the harness bootstrap share: no project source, provider
credentials, SSH agent, host home or browser profile is exposed. It installs a
launcher, then shuts down. Verification uses filesystem clones of the stopped,
read-only base; mutable verification state is never copied back.

During verification, Tart's file-handle network device connects to a small pinned
harness-owned frame dropper. It consumes frames and opens no sockets or forwarding
path. It uses no root/SUID networking helper and provides no host, LAN or internet
route. Clipboard, audio and USB accessory sharing are disabled. Only the approved
source/launcher share (read-only) and the private output volume (writable) cross the
VM boundary. The expected output and host approval are not mounted in the guest.

Each guest has two CPUs and 4096 MiB RAM. An independent host guardian enforces the
wall-clock deadline even after controller loss. A 64 MiB disk image bounds the
shared output volume. Source is limited to 32 MiB; individual retained output files
to 4 MiB and logs to 1 MiB. The guest root disk is a 50 GB copy-on-write image. A machine-wide saved slot
prevents another project from starting a VM until an interrupted run is recovered.
Root-disk growth has a host free-space watchdog (12 GiB reserve), **not a hard
per-run disk quota**. Other host processes and rapid writes can race that watchdog.
New runs require at least 24 GiB free. Hardware-virtualisation bugs and malicious
host processes are outside this boundary.

Full base hashes are calculated during registration. Ordinary runs compare each
base file's device, inode, size, nanosecond modification/change times and mode
against its registered identity, plus tool and protocol hashes. Changing the base
or runner invalidates approvals. This cache assumes an operator-controlled host;
it does not claim protection against a privileged process falsifying filesystem
metadata.

## Results and recovery

A host comparison decides whether observed stdout and exit status match the saved
expectations. Outputs are read only after the guest stops; screenshots/GUI and
application acceptance are not inferred from a passing script. Guest-produced
output can be fabricated by an adversarial project, so it remains labelled
**unverified artifact / native diagnostic result**. Continue to use independent
source acceptance for application changes.

Records live under `<project>-harness/native/`; the toolchain, immutable base and
provisioning evidence live under `~/Library/Application Support/Harness/`. A stopped
or failed run retains its observations and reports. Cleanup stops only the owned
VM and detaches only its matched output image. Ambiguous resource state is retained
for recovery. After a killed controller, `native recover` verifies the saved controller PID,
recovers only that ended writer’s locks, and removes its owned resources. A live or
different writer is refused. Then retry from fresh source. Verification restarts;
it does not resume a partially executed native script. This lane never removes a
user VM or a foreign mounted image.

The current workflow creates unsigned local artifacts only. iOS simulator
runtimes, Android SDK/Java/emulators, native UI automation, signing, Windows runners
and GPU workloads need their own provisioning and acceptance evidence.

## Exercised boundary

The installed base was verified on 2026-09-27 with macOS 26.6.2 and Swift 6.3.3.
Real disposable VMs compiled and ran Swift, preserved host source, rejected
incorrect expected output, stopped at their deadline and recovered after the
controller was forcibly killed. The receipt is retained in the runtime’s
`native/boundary.json`. `npm run verify:native` repeats these integration fixtures;
it requires the provisioned Mac and is separate from the portable unit suite.

Packaged macOS Electron GUI journeys are a separate capability described in
[MACOS_GUI.md](MACOS_GUI.md). Their tools use a prepared clone named
`harness-macos-gui`; activating it updates the native base identity and requires
reviewing existing script approvals. The original script base is retained.
