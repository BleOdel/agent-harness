# Packaged Linux notes example

From an empty project directory, run `harness init --desktop`, then `npm test`.
Use `harness guide` → **Linux desktop apps** to prepare the image, approve the
starter journey, verify it and export the package/evidence. The source template
lives in `src/desktop/template` in the harness, so this example does not keep a
second copy of the same app.

[journey.json](journey.json) is the exact starter journey for explicit scripts.
The [desktop guide](../../DESKTOP.md) explains requirements, commands and limits.
The example requires no model call, provider credential or npm install in the
created project. It tests Linux Docker, not the host macOS/Windows desktop.
