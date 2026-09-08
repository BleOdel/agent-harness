# Follow-up work beyond the team roadmap

`TEAM_PLAN.md` is the authoritative implementation order: M0 through M6,
including assigned agents and verified integration. This file retains the
other v2 follow-ups for later prioritization.

v2 is built. M0–M5 shipped, the scorecard is in `V2_RESULTS.md`, and
nothing from the original plan is outstanding. Everything below came from
*using* it — which is also where every defect in this project has come
from, and worth remembering when reading the sizes.

## The one decision that changes this plan

**Is this a Node tool, or a general one?**

The assertion counter hooks `node:assert`. Test collection expands shell
globs. `deps` runs `npm install`.

Point the harness at a Python, Go, Swift or Kotlin project and **every run
is refused**. Measured: a project whose tests are a shell script exiting
zero with everything passing gets `tests: exited zero but executed no
assertions, so nothing was verified`. The gate fails closed, which is the
right direction and makes the harness unusable rather than untrustworthy.

An earlier draft of this file said the gate "silently counts nothing",
implying it passes. It does not, and the difference matters: the failure
is loud, immediate, and the same on every run.

That is not a bug to fix in passing. It decides whether N2 below is the
most important milestone here or one that should never be built.

---

## N1 — The Oracle, and it annotates rather than blocks

**~250 lines.**

Nothing currently judges whether the code is *good*. The Reviewer answers
two questions — is each acceptance criterion satisfied, is anything
unaccounted for — and would pass a working, hideous, unmaintainable
implementation without a word.

A third read-only process, its own container, given the diff and the
project's own `AGENTS.md` conventions. It asks one question the others do
not: *would a careful maintainer of this project accept this?*

**It records, it does not block.** Its findings go into the run record and
`look` shows them. This is the whole design decision, and it is deliberate:
a quality reviewer that always finds something becomes noise the operator
learns to skip, and a noisy blocker is worse than no blocker because it
trains people to override gates. Let it earn blocking by being right for
a while first.

**Verify** the same way the Reviewer was, and the control matters more
here than anywhere:

- it must find the real thing in code that works but is bad — a 200-line
  function, a name that lies, a test asserting the implementation rather
  than the behaviour, a swallowed error;
- it must stay **silent** on the four clean projects already built. An
  Oracle that comments on `calc` has failed.

**Kill criterion:** if it cannot stay quiet on good code after two prompt
revisions, delete it. Machine judgement of quality either works or is
noise; there is no useful middle.

---

## N2 — Language adapters

**~400 lines. Only if the answer above is "general".**

Two gates are Node-specific and everything else already is not. Make
those two pluggable:

- **assertion counting** — today an `--import` hook over `node:assert`;
  for pytest a `conftest.py` plugin counting rewritten asserts; for JUnit
  or XCTest, parsing the runner's own XML report;
- **test collection** — today shell-glob expansion; elsewhere it is
  whatever that runner's discovery does.

Everything else — the container, the copy, the claim, size, the diff, the
Reviewer, undo, the record — is language-agnostic already and stays
untouched.

**Verify** by building a small Python project end to end through the full
pipeline, including a deliberately assertion-free test suite that the
gate must refuse. Second language proves the abstraction; a third would
only confirm it.

**The container is the other half.** It runs `node:26-bookworm-slim`,
which has no Android SDK, no Swift toolchain and no Xcode. Android would
need a different image; iOS cannot work in this model at all, because
Xcode does not run on Linux. A React Native or Expo project is the
interesting middle: its JavaScript layer is testable here today, and only
the native build is not.

**Kill criterion:** if the adapter for a second language cannot reach the
same standard as the Node one — a suite that asserts nothing must be
refused — then say plainly in the README that this is a Node tool, and
stop.

---

## N3 — The small debts

**~150 lines. Do these first; they are cheap and two are embarrassing.**

- **`t.assert.ok` is invisible to the counter.** Node implements it
  natively so it never reaches the patched module. A suite whose every
  assertion is that one call reads as zero. Named in the gate's failure
  text today, which is honest but not a fix.
- **No `LICENSE`.** Irrelevant while the repo is private, blocking the
  day it is not.
- **No way to drop or edit a feature item** except by hand-editing
  `features.json`. `harness drop <id>` and `harness edit <id>`.
- **`plan`'s interactive path has no automated test.** It was verified
  once, by hand, by one person. A pty test would cover the one path with
  no coverage at all.

---

## N4 — CI

Implemented locally in team M0: a push/PR check workflow and an explicit
manual Docker/model verification workflow. See `TEAM_M0_RESULTS.md` for
validation and runner setup status.

## Recommended order

Complete `TEAM_PLAN.md` M0–M6. Revisit N1–N3 after the coordinated team
release, unless one blocks a milestone's acceptance checks.

## Not planned, and why

**Unrestricted worker-spawned subagents.** Pi has a subagent extension
example, but assigned workers in this harness will be launched and tracked
by the host controller. Shared interfaces, dependency ordering and serial
integration belong to `TEAM_PLAN.md`.

**Tool registration.** The builder has `bash` and writes its own scripts.
Named, persistent tools mean Pi extensions, which are off deliberately:
the argument here rests on knowing what the model can do.

**Sprints, ceremonies, stakeholder roles.** Most Scrum artefacts already
exist under other names — `features.json` is the product backlog, the Must
queue is the sprint backlog, the gates are the definition of done, the
Reviewer and `look` are the review, the milestone write-ups are
retrospectives. What is left coordinates people, and there is one
operator.

**Pushing to a remote.** `commit` is local and reversible. A push is
neither, and it is not the harness's decision.
