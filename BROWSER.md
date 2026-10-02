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
Supported keys are Tab, Shift+Tab, Enter, Space, Escape, ArrowUp, ArrowDown, Backspace, Delete and ControlOrMeta+A.
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
hostile application security. They do not replace project-test or source-review gates. Standalone journeys remain
separate diagnostics; journeys explicitly approved as acceptance cases are executed
on the frozen candidate and included in its acceptance proof. They are never
automatically converted into a human assessment.

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

## Typed acceptance cases

`harness checks prepare` can now prepare `kind: "browser"` cases with an empty
command-step list and a `browser` journey. Independent design review and operator
approval are still required. Approval binds the browser image/toolchain/protocol.
The host withholds expected values from the driver and all instructions from the
application, just as for standalone browser runs. The result records the candidate
source digest and retained browser run; applying work re-assesses those observations.
Changed runtime pins, missing observations and another candidate's evidence fail closed.

Manual observations remain pending until candidate-bound operator review; unsupported capabilities still need a decision. HTTP probes cannot substitute
for browser observations. Existing
standalone `browser approve` and `browser verify` commands continue to work.

## Author workflows

Reviewed JSON journeys and generated acceptance journeys also support:

- `capture`: retain one element's nonempty text or input value under a unique name.
  Later `fill`/`paste` actions use `valueFrom`; clipboard/download expectations use
  `expectedFrom`. Capturing a value is setup, not proof by itself.
- `clipboard`: observe text from Chromium's clipboard. `paste` uses a real keyboard
  paste into the selected input. The laptop clipboard is never used.
- `download`: click an element, retain at most 64 KiB of UTF-8 file content for host
  comparison, and delete the temporary download. The application cannot choose a
  host output path.
- `context`: select a fresh, independent profile or return to a named one. `page`
  selects another tab sharing that profile's storage. Limits are four profiles and
  twelve pages per journey, including the initial `main` profile and page.
- `storage`: scan local/session storage, IndexedDB records, Cache API entries and
  cookies for a previously captured marker (`absentFrom`). The host also scans URL,
  base64 and hex encodings. Oversized or unsupported stored values stop verification;
  this does not prove absence of every possible encoding or OS-level copy.
- `network`: inject `abort` or a fixed JSON `503` for one exact same-origin pathname
  and method in the current profile. `normal` removes that fault. `requestCount`
  observes cumulative intercepted requests for that path/method, including faults.
  These actions test UI recovery; they do not prove backend failure handling.
- `attribute`: observe bounded semantic/form attributes. `select` chooses a native
  select option. DOM roles and axe results do not prove screen-reader announcements.

Expected values and privacy comparisons stay on the host. Captured fixture values
and storage snapshots are retained as diagnostic evidence, so use fictional test
accounts only. Browser capability changes invalidate saved outline review receipts;
changes to the driver or schema require explicit approval of the new runtime pin.
The basic interactive setup menu remains available; these advanced actions are
specified in reviewed JSON or generated acceptance journeys.

### Keyboard typing in acceptance journeys

`type {selector,value}` sends 1–256 printable ASCII characters through Chromium
keyboard input, preserving the current value and caret position. Use separate
`type` and text/count observations for successive live updates. `fill` replaces
values, `paste` exercises clipboard paste, and `press` supports Backspace/Delete;
these are distinct interactions. Use fill/paste for large or Unicode fixtures.
Typing alone is setup and cannot make a journey pass.

A browser capability update invalidates the outline capability receipt. Saved
missing-action replies from a recognized earlier capability version are archived
once so preparation can review the outline and generate a new journey. Contract
choice blockers, completed cases and approval records are retained. This does
not approve a check or provide evidence that the application works.

### Compact boundary-test data

Fill and paste accept `valueRepeat: {text: "a", count: 10001}` instead of a
literal `value` or captured `valueFrom`. The harness validates the fixture and
expands it inside the runner before the normal interaction. The repeated unit
must be 1–128 characters, contain no NUL, and produce at most 12,000 UTF-16 code
units using a positive integer count. This avoids generating long literals or
capture/paste construction chains for length-boundary tests. It does not bypass
form limits, replace typing evidence, or provide a passing observation by itself.
The shared expansion code is included in the browser runtime approval pin.

## Human review of staged browser work

After automated verification, `harness continue` retains a candidate. Run
`harness stage preview <run-id>` to open the dependency-free Node app through a
loopback URL, with isolated temporary data, then inspect it using your actual
browser and assistive technology. Stop the preview with Ctrl+C and run
`harness stage review <run-id>` to record each observation and approve application.
The preview and observations are tied to the retained candidate; edited source,
requirements, checks or execution settings cannot reuse them. This is operator
attestation, not a substitute for Chromium evidence or automatic screen-reader
certification. Preview containers have no external network or credential mounts.
