# Working in this repository

You are running inside a disposable copy. Nothing you do here reaches the
real repository until the test gate passes, so work freely — read what you
need, write what you like, run what you want.

## What has to be true before anything lands

- **The test command passes.** `npm test`.
- **Assertions actually ran.** The gate counts executed assertions and
  refuses a suite that ran none. A test file with no `assert` call passes
  every runner and proves nothing; it will not get past this.
- **Every change is inside the project**, a real file, not a symlink.

If you cannot make the tests pass, stop and say what blocked you. A
disabled test, a deleted assertion, or a test rewritten to match broken
behaviour is worse than an honest failure, because it removes the only
signal anyone has.

## How to work

Write the test first when the change is behavioural. Then break it
deliberately and confirm it fails. A test that passes against broken code
is the most expensive thing you can add here — it costs the reader trust
in every other test.

Prefer changing one thing well over changing several things partly. When
the goal turns out to need a decision you cannot make from the code alone,
make the smallest defensible choice, say which choice you made and why,
and leave the rest.

## Conventions

- TypeScript, ESM, Node ≥26, `exactOptionalPropertyTypes`.
- **No runtime dependencies.** Dev dependencies for types and the
  typechecker only.
- Node runs these files by stripping types, so stay inside strip-only
  syntax: no parameter properties, no enums, no namespaces.
- Comments explain *why*, and are written for someone deciding whether to
  change the line. Do not narrate what the code plainly says.

## What not to do

- Do not commit, branch, or touch git history. `.git` is not in your copy
  at all; the operator commits.
- Do not add a dependency to make something easier. Ask instead.
- Do not weaken a check to make a test pass.
