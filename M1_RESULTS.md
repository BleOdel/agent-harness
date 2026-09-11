# M1 — what the walking skeleton actually did

> Historical sequential-v2 results. Counts, capabilities and limitations below
> describe that milestone, before the team M0–M6 implementation. See
> [README.md](README.md) for current behavior and [TEAM_PLAN.md](TEAM_PLAN.md)
> for the completed team milestones.

The plan called this "the milestone that decides the project", and set the
test: build `buildlog` ticket 3 with it, then rebuild tickets 1 and 2 from
an empty project, measuring against v1's baseline of **76 lines of
application code and 135 audited actions in a day**.

All runs used `openai-codex`. No Claude model was used anywhere.

## The measurements

| | v1 (measured) | v2 M1 (measured) |
|---|---|---|
| tickets 1 + 2 | one working day | **254 seconds** |
| application lines | 76 in a day | **544 hand-written in 4m14s**, plus 632 generated |
| operator actions | 135 audited | **1 command per ticket** |
| escalations per change | 1.0, by construction | 0 |
| denials | 9 in 32 actions | 0 |

Per run:

| run | project | elapsed | files | assertions counted |
|---|---|---|---|---|
| smoke | scratch | — | 2 | 5 |
| ticket 3 | real `buildlog` | 107s | 7 | 15 |
| ticket 1 | empty | 107s | 7 | 5 |
| ticket 2 | continuing | 147s | 7 | 20 |

Every run passed its gate, applied, and destroyed its sandbox. Every
acceptance criterion in `PLAN.md` was met on inspection: exact navigation
targets, byte-for-byte staleness tests on every committed page, flat test
files, the fluid 16:9 labelled placeholder embed.

**The "0 escalations" figure is not yet meaningful.** M1 has no escalation
mechanism, so nothing could have escalated. It is recorded to be replaced,
not celebrated.

## What the gate caught, and what it could not

The assertion counter is doing real work. In two of four runs the model
reported an assertion count that did not match the one measured inside the
container -- it claimed six where five ran, and four "tests with
assertions" where twenty assertions ran. Neither was consequential, and
that is the point: the gate does not ask the model how well it did.

The gate cannot see scope. **Both from-empty runs added a build script and
an `npm run build` that no ticket asked for.** Nothing in the tickets
mentions a build step; tickets 1 and 2 were satisfied by committed HTML
and a staleness test. The suite passed, assertions ran, every change was
inside the project, and the harness applied work the operator did not ask
for, because no machine check can express "this was not the request".

That is the entire argument for M3's Reviewer, now supported by evidence
rather than by expectation. It is also the exact shape of v1's finding
that human review caught two real defects every automatic check passed.

The rebuilt tickets 1 and 2 also diverged from the originals -- a shared
`render-document.js`, `scripts/` rather than `src/` for the build script.
Not wrong, and not something a test can call wrong.

## What building it found

A defect on the first run against a real project, caught before it ran:
`buildlog` still held the previous harness's `.secure-harness` directory,
containing a provider credential and an audit signing key. The container
keeps the model off the host filesystem, but **the copy is made by the
host**, so anything sitting inside the project walks in through the front
door. Secret-bearing names are now withheld from the copy, and the
withholding is announced rather than silent, because a project whose tests
need a `.env` will fail the gate and the operator has to be able to
connect the two.

Three more defects, all one family -- a green result that means nothing
ran -- are recorded in the M1 commit message.

## Verdict

The central bet holds. The mechanism is roughly two orders of magnitude
faster than v1 at the same work, on the same tickets, with the same
acceptance criteria met.

The unrequested build script is the boundary of what machine verification
can decide, and it appeared in two runs out of two. M2 and M3 are aimed at
exactly that gap.
