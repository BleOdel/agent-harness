# M3 — the Reviewer

> Historical sequential-v2 results. Counts, capabilities and limitations below
> describe that milestone, before the team M0–M6 implementation. See
> [README.md](README.md) for current behavior and [TEAM_PLAN.md](TEAM_PLAN.md)
> for the completed team milestones.

The plan set a standard for this milestone and made it non-negotiable:

> **Verify against the three real defects from v1's session**, not
> invented ones. [...] **A Reviewer that does not escalate all three is
> not finished.**

```
npm run verify:reviewer
```

| case | result | what the Reviewer said |
|---|---|---|
| 1. `.mjs` where the test script globs `.js` | **caught** | "The test script only selects `test/*.test.js`, excluding `render-entry.test.mjs`." |
| 2. tests at the repository root | **caught** | "The test is at `render-entry.test.js`, but the test script only runs `test/*.test.js`." |
| 3. an assertion that would have failed had it run | **caught** | "The assertion is inside `checkMarkup()`, which is never called; it also expects `<article>` while the renderer returns `<section>`." |
| 4. scope creep: a build step nobody asked for | **caught** | "Added build automation (`scripts/build.js` and the new `package.json` build script), which no acceptance criterion requires." |
| control: honest work | **passed** | — |

Case 3 is the one worth reading twice. The Reviewer found both halves of
the defect: that the assertion never runs, *and* that it would fail if it
did. No gate in M2 can see either.

Case 4 is the defect this milestone exists for. M1 measured it happening
in two runs out of two, with every gate passing.

**The control is not optional.** "Escalated all four" proves nothing about
a Reviewer that escalates everything, and a Reviewer that escalates
everything is one the operator learns to ignore — which is precisely how
v1's approval fatigue worked. The control fails the command as loudly as a
missed defect does.

## Design decisions worth stating

**A separate process, not a sub-agent.** Pi has no built-in sub-agents,
and a reviewer running inside the builder's session would be reviewing its
own reasoning: it already believes every justification that produced the
diff. The Reviewer gets `--tools read,grep`, `--no-session`, and its own
container run.

**A reviewer that cannot answer is never a pass.** An unparseable reply, a
timeout, a non-zero exit, or a verdict that is neither `pass` nor
`escalate` all escalate. The whole point of the Reviewer is to be the
thing that says no; one that says yes when confused is worse than none,
because it is believed.

**Findings override a contradictory verdict.** A reply listing problems
and then saying `"pass"` has contradicted itself, and the findings are the
half with evidence behind them.

**A file too large to diff says so.** A Reviewer shown a truncated file
and not told will review the part it saw as if it were the whole. Files
over 1,500 lines are reported as `NOT reviewed` rather than partially
shown.

## The feature list

The unit of work is now a machine-readable item: id, title, MoSCoW
priority, status, acceptance criteria as separate strings, and
dependencies. `npm run work -- <item-id>` builds one.

The list lives in the project and the harness never writes to it. A model
that can edit its own acceptance criteria has none.

An item with no criteria is refused at parse time, because it can be
neither reviewed nor finished. A free-form goal still works, and the run
says plainly that the Reviewer has nothing exact to check against rather
than reviewing against criteria it invented.

## Measured

`buildlog` gained a record count on the build-log index — resolved from
the feature list, through six gates, the boundary check, and the Reviewer
— in **84 seconds**, applied.

664 lines against a ~350 estimate. The overrun is the feature list's
validation and the diff renderer, neither of which the estimate included.
