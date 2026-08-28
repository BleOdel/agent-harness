# M2 — the rest of the gates

Six gates now stand between the model and the repository. Each one was
broken deliberately and confirmed to stop the apply, against a real Docker
daemon rather than a fake.

| gate | question | verified by breaking |
|---|---|---|
| tests | does the suite pass? | inverted `add` to `a - b` |
| tests | did any assertion run? | removed the assertions, suite still green |
| test-collection | does the runner reach every test file? | put a test at the repository root |
| typecheck | does the project typecheck? | applies only where declared |
| build | do committed artefacts match their sources? | a build that rewrites a committed file |
| size | is the change within its ceilings? | 41 files, 4,001 lines |
| claim | does the claim match what changed? | an undeclared file; a missing claim |

`npm run verify:gates` runs all of it. It refuses to run rather than
skipping when the daemon or image is absent.

## The one that matters most

**test-collection.** `node --test test/*.test.js` does not recurse and
never reaches the repository root. A test file anywhere else is green by
never running, and it hides whatever it was written to catch — in v1 that
defect hid a second defect behind it.

The gate does not parse the test command's semantics. It expands the
command's glob arguments with the same matcher the shell will use, and
compares that to every test file on disk. `npm test` is resolved through
`package.json` first, because otherwise `npm` and `test` expand to nothing
and every project using `npm test` passes vacuously.

## Attribution before retry, verified live

On a gate failure the model gets one more attempt and is handed a named
diagnosis — what failed, why it matters, what would count as fixed —
rather than a log to guess from.

Watched working: given a goal that deliberately placed a test where the
runner could not reach it, the first attempt failed `test-collection`, and
the second attempt widened the test command and passed. The model was
never shown the runner's output.

## What running it found

The claim gate refused an honest claim. A model that lists
`.harness-claim.json` among the files it wrote is telling the truth, and
the harness strips that file from the change set before checking — so the
gate reported "declared but not changed" for a discrepancy the harness
itself created. It cost a live run its retry before it was noticed. The
claim file is now excluded from both sides.

That is the second time in this project a check has been correct about a
thing it was not actually measuring.

## Cost of the new gates

The run against `buildlog` that added a fourth record: six gates, all
passing, **70 seconds**, no obstruction. A clean run on a small project:
**30 seconds**. The claim requirement did not slow the model down or
require a second attempt in either case.

## What these gates still cannot see

Scope. M1 found both from-empty runs shipping a build script no ticket
asked for; nothing here would catch that, because every gate is about
whether the code is sound rather than whether it is the work requested.
The claim makes scope *visible* — the model must name every file — but it
cannot decide whether naming it was legitimate.

That decision is M3's.
