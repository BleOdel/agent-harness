# Stage an existing artifact for review

Use a project that already has a retained build, passed desktop package or evaluated
model. In `harness guide`, select **Prepare and stage a release**, then:

1. Prepare a draft from the artifact you want to review.
2. Use a name such as `notes-asar`, version `0.1.0`, and an existing output folder.
3. Review and approve the displayed hash, version and exact destination.
4. Dry run, stage, inspect, and repeat Stage to verify the unchanged completed result.

For the Electron notes example, the staged file is an ASAR, not an installer. Its
external runtime is still required. This workflow transfers one artifact plus
release metadata; it does not replace the desktop command's bundle export.

The automated equivalent is `test/releases-terminal.test.ts`. It uses inert fixture
bytes and verifies the complete terminal workflow. A development demonstration also
staged the actual ASAR from the E6 notes app after its packaged GUI checks passed.
No model call, remote upload or signing is performed. See [RELEASES.md](../../RELEASES.md).
