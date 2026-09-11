# Harness v2 — scope

> Historical sequential-v2 design, preserved as proposed. Some requirements below
> were changed during implementation: model containers use bridge networking,
> team execution supports assigned roles, and undo has explicit limits.
> [README.md](README.md), [ARCHITECTURE.md](ARCHITECTURE.md) and
> [THREAT_MODEL.md](THREAT_MODEL.md) describe the current guarantees and limits.

A productivity harness: a coding agent that builds real applications.

Rescoped after measuring v1.20 over a full working session. v1 produced
**76 lines of application code and 135 audited actions in a day**. The
cause was not a defect. Human review sat in the critical path of every
change, which is both the guarantee and the ceiling: it does not scale
with project size, and it degrades exactly when changes grow large enough
to matter.

## The change

| | v1 | v2 |
|---|---|---|
| human review | **mandatory**, every byte | **selective**, on escalation |
| machine verification | confirmatory, after review | **mandatory**, before anything lands |
| the model | proposes text, never acts | **works freely inside a disposable copy** |
| what reaches your repository | whatever you approved | only what the machine proved |

Today supplied the evidence for the inversion. The staleness tests proved
mechanically that committed HTML matched its renderer byte-for-byte — you
never needed to read `build-log.html`. Where the machine had nothing to
say, file *locations*, is exactly where both real defects hid. Machines
are better at the parts humans skim, and humans are needed for the parts
machines cannot state.

## The guarantee

> **The model works only on a copy. Nothing reaches your repository until
> the machine has proved it, and nothing that reaches it is irreversible
> or unrecorded.**

This is a different guarantee from v1's "the model cannot act", and it is
weaker in one direction and stronger in another. Stated plainly rather
than blurred:

- **Given up:** pre-approval of every change, and the sealed read scope.
  The model reads what it needs and writes what it likes — inside a
  sandbox it cannot escape.
- **Gained:** the machine must now *prove* things it previously only
  confirmed, and it must prove them before anything is applied.

## What the machine must prove — all mandatory

Nothing is applied unless every one of these holds:

1. the project's tests pass, with assertions **demonstrably executed**;
2. the typecheck passes, where the project has one;
3. no path outside the declared work boundary was touched;
4. nothing was deleted that the change did not declare;
5. no network request was made during the run;
6. generated artefacts match their sources (the staleness class);
7. the change is within its declared size and file count.

Any failure stops and reports. It never applies and asks afterwards.

## When a human is pulled in

Selective does not mean absent. You are escalated to when:

- any gate above fails;
- the change touches a sensitive path — credentials, audit state, CI,
  lockfiles, anything on a list you control;
- anything is deleted;
- a dependency is added;
- cumulative change crosses a threshold you set;
- **the Reviewer disagrees.**

## The Reviewer

One second agent, not seven roles. It did not write the code. Its only
job is to answer, against the ticket's stated acceptance criteria: *does
this do what was asked, and is anything here not accounted for?* It
passes silently or escalates with reasons.

This is what takes review off your critical path without removing it. The
evidence it is needed: today the model wrote a test in a folder where it
could never run **and** wrote that test wrong, and noticed the second
fault only when forced to fix the first.

Backlog items carry a MoSCoW priority. That is the whole of the process
machinery — no sprints, no stand-ups, no stakeholder roles. For one
operator those coordinate nobody.

## The shape

```
harness init <dir>
harness

  > add <item>          backlog item, with acceptance criteria and MoSCoW
  > work                take the next Must; agent builds, machine proves,
                        Reviewer checks; applies or escalates
  > look                what happened, what is pending, what escalated
  > show <id>           the exact diff, when you want it
  > undo <id>           reverse anything, at any time
```

## What this costs, honestly

**This is a threat-model reversal, not an adjustment.** `THREAT_MODEL.md`
must be rewritten rather than amended: the model now executes code, reads
freely, and writes without prior human approval. The containment boundary
becomes the only thing standing between it and your machine, so it moves
from "defence in depth" to "the guarantee", and must be treated that way —
no repository mount of anything private, no network beyond the provider,
no host filesystem.

Two things this makes possible that were not before: a bad change can
land before you see it, and a subtly wrong change can pass every gate.
Both are bounded by reversibility and recording, not prevented.

If that trade is unacceptable, v1's model is the correct one and this
document is wrong. It is a real choice, and it should be made once,
deliberately, rather than drifted into.

## Size and target

Under 6,000 lines. v1 is 25,327.

Success is measured the way the failure was: **application code shipped
per day, and escalations per change.** v1's baseline is 76 lines a day
with every change escalated by construction.

## What would falsify this

If escalations settle above roughly one in three changes, the human is
back in the critical path with extra machinery around them, and the
inversion bought nothing. That is the number to watch from the first week.
