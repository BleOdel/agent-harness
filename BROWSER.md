# Browser UI verification

`harness browser` adds a real Chromium diagnostic lane for dependency-free Node
HTTP applications. It never launches project code directly on your laptop.

## Guided use

1. Run `harness browser image` once to download Chromium, Playwright and axe into
   a dedicated Docker image. The package lock pins tool dependencies; the built
   image's immutable ID and tool versions are pinned when a journey is approved.
2. Run `harness guide`, choose **Browser UI checks**, then **Set up a browser journey**.
3. Choose the Node entry file, optional application database environment variable,
   and observations. Review the exact actions and expectations before approval.
4. Select the journey by title to verify it. Inspect the saved run and export its
   screenshots or reports using the artifact IDs shown by `browser inspect`.

No AI call is needed for setup or execution. The operator may also approve a
reviewed JSON journey with `harness browser approve <file>` and run
`harness browser verify <journey-id>`. `harness browser list` lists saved work;
`browser doctor` checks installed tools. Preparation is explicit, never triggered
by an untrusted project. `HARNESS_BROWSER_IMAGE_ID` can select an immutable image.

## A small journey

```json
{
  "version": 1,
  "title": "Reading room at mobile width",
  "entry": "src/server.js",
  "port": 4173,
  "databaseEnv": "TO_BE_HEARD_DB",
  "timeoutSeconds": 90,
  "steps": [
    {"action": "goto", "path": "/"},
    {"action": "text", "selector": "h1", "expected": "Stories, at your pace."},
    {"action": "viewport", "width": 320, "height": 800},
    {"action": "overflow"},
    {"action": "accessibility"},
    {"action": "screenshot"}
  ]
}
```

Other actions: click, fill, press, count, focused, reload and motion. Motion takes
`value: "reduce"` or `"no-preference"`; the initial browser preference is reduce.
Supported keys are Tab, Shift+Tab, Enter, Space, Escape, ArrowUp and ArrowDown.
Text checks require exactly one matching element with exact text. Goto/reload
require HTTP 200 and reject redirects. For asynchronously loaded UI, put a visible
text observation before counting dependent elements. Navigation paths stay on the
isolated application's origin. A journey has 1–60 actions and a 10–300s limit.

## Isolation and evidence

The app runs from a read-only safe snapshot in one offline container. Its database,
when configured, lives on a bounded temporary filesystem and is discarded. The
browser runs in a separate container with a harness-owned driver, action-only
instructions and a dedicated output directory. It shares only the app's network
namespace, which has no external network or published host ports. No browser
profile, model credentials, project state, Docker socket or laptop home is mounted.
The app cannot edit driver instructions, expected values or browser observations.

The host compares observations with saved expectations. Source, approved journey,
image/toolchain and driver protocol identities bind each result. Screenshots,
observations, browser logs and axe reports are retained as artifacts. Source
changes during verification invalidate success. Nothing is applied to the project.

Each container has 2 CPUs, 1536 MiB RAM and 256-process limits; both run non-root
with a read-only root and dropped capabilities. Chromium's inner sandbox is
turned off inside this restricted browser container. The container boundary is
therefore essential. App temporary data is limited to 128 MiB; each /tmp to 256 MiB.
Source is limited to 32 MiB. Tests must use fictional data and temporary accounts.

On cancellation/timeout the host cleans up only containers with the matching
run, token and image. Inner deadlines also bound containers if the controller
dies. An interrupted run remains visible; use `browser recover <run-id>` after
the writer ends, then run the approved journey again. This restarts a clean
browser/app session; it does not resume an in-flight UI interaction.

## Limits

This is browser evidence, not complete usability or accessibility certification.
Axe checks common WCAG A/AA rules and saves incomplete findings for human review;
keyboard, assistive-technology and visual judgement still need appropriate
observations. A page may spoof its own DOM, so these diagnostics do not prove
hostile application security. They do not replace independently approved source
acceptance and are not automatically attached as operator-reported evidence.

Only Chromium on Linux and dependency-free Node servers are supported initially.
This is not native macOS Safari, Windows, mobile emulator, iOS simulator or GPU
verification. npm dependencies/build steps, browser-session resume, authentication
secrets and production URLs are outside this lane. Source cannot write within its
read-only app directory; configure runtime data via the explicit database variable.

## Verification

`npm run verify:browser` runs real Docker/Chromium fixtures for keyboard actions,
reload persistence, source/driver separation, screenshots, axe and overflow.
Wrong text, overflow and a stalled route must fail; orphan recovery is exercised.
The ordinary suite checks schema, expected-value withholding and host assessment
without requiring Docker. The installed browser tool image is required for the
real verification command; missing tools fail explicitly.
