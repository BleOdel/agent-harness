# Harness v2 — build plan

Reads with `V2_SCOPE.md`. That says what v2 is; this says how it gets
built, in what order, and what proves each step. Consolidated after three
rounds of revision, including what Pi already provides and what
established harness-engineering practice adds.

## What is being built

A coding agent is a model plus a harness. Pi is the model side. v2 is the
other half: the surface through which the model meets context, invokes
tools, keeps state, and receives feedback.

**The guarantee:** the model works only on a copy; nothing reaches your
repository until the machine has proved it; nothing that reaches it is
irreversible or unrecorded.

**The bet being tested:** machine gates plus one independent Reviewer
catch enough that a human is pulled in on fewer than one change in three.
If that is false, nothing later matters.

## The ordering principle

**Prove the risky assumption first.** v1 was built for forty days before
anyone measured whether it could finish a job. M1 answers the bet in a
day or two.

## What already exists

| | |
|---|---|
| **Pi's agent loop** | `read`, `bash`, `edit`, `write`, `grep`, with read-only mode and per-tool disabling. v2 does not write an agent. |
| **v1's containment** | `docker-pi-sandbox.ts`, `node-permission-sandbox.ts` — ~1,400 lines, never failed, never obstructed |
| **v1's verification** | `docker-verifier.ts` — network-disabled snapshot runs, ~900 lines |
| **v1's assertion gate** | `assertion-evidence.ts` — proves assertions executed, ~120 lines |
| **v1's recovery store** | `recovery-store.ts` — atomic multi-file sets with snapshots, ~500 lines |

**New repository.** v1 stays tagged at v1.20.0, working, as the fallback.

---

## M0 — Containment and the threat model

The precondition. In v2 the model executes code and writes files, so
containment stops being defence in depth and becomes the whole guarantee.

- copy the two sandbox modules; the mount becomes a read-write disposable
  copy rather than a read-only repository;
- nothing private is ever mounted: no audit state, no credentials, no
  `.env`, no host filesystem;
- write `THREAT_MODEL.md` fresh for this posture. Do not amend v1's.

**Verify:** from inside the sandbox, attempt to read a file outside the
copy, reach a host other than the provider, and persist past teardown.
Each must fail.

**Size:** ~1,500 lines, mostly copied. **If the threat model cannot be
argued honestly, stop here** — that is worth learning in a day.

---

## M1 — The walking skeleton

```
work <goal>
  → copy the repository into a disposable sandbox
  → run Pi in the container, tools enabled, pointed at the copy
  → gate: tests pass with assertions demonstrably executed
  → gate: no path outside the declared boundary was touched
  → apply to the real repository, with a recovery snapshot
  → destroy the sandbox
```

Also in M1, because they are cheap and shape everything after:

- **`AGENTS.md`, under sixty lines**, in the project. The instruction
  layer. Not a catalog of sealed skills — v1's `tdd` needed correcting
  twice and could not be.
- **Silent on success.** The gate reports a verdict. Detail appears only
  on failure. v1 dumped a full passing test log into the transcript every
  cycle, which is noise for the operator and context the agent carries.
- **Sandboxes are destroyed after every run**, pass or fail, with the
  path recorded so a failure can be reproduced.

No Reviewer, no backlog, no priorities, no record beyond stdout.

**Verify — the milestone that decides the project.** Build `buildlog`
ticket 3 with it, then rebuild tickets 1 and 2 from an empty project.
Record **application lines shipped per hour** and **escalations per
change**, against v1's measured baseline of 76 lines a day with every
change escalated by construction.

**Size:** ~350 lines.

---

## M2 — The rest of the gates

Only once M1 shows the shape works. Two categories.

**Correctness gates:** typecheck passes; nothing deleted that the change
did not declare; no network request during the run; generated artefacts
match their sources; change within declared size and file count.

**Victory-declaration gates** — the failure mode that beat every
automatic check in v1, twice:

- every acceptance criterion is accounted for;
- every file the item said it would produce exists;
- no test file sits outside where the runner actually collects them.

That last one alone would have caught the defect that hid the other
defect.

**Attribution before retry:** when a gate fails, classify the failure and
hand the agent a diagnosis, not a log to guess from.

**Verify:** break each gate deliberately and confirm it stops the apply.

**Size:** ~600 lines.

---

## M3 — The Reviewer, and the feature list

**The feature list** becomes the unit of work: a machine-readable item
with an id, acceptance criteria, status and MoSCoW priority. Not prose —
the Reviewer needs something precise to check against.

**The Reviewer** is a second, separate Pi invocation. Read-only tools, its
own process, no shared context with the builder. Given the diff and the
item's acceptance criteria, it answers one question: does this do what was
asked, and is anything here unaccounted for? It returns a condensed
verdict, never a transcript, and either passes silently or escalates with
reasons.

Separate process rather than a sub-agent — Pi has none built in, and one
reviewing inside the builder's session would be reviewing its own
reasoning.

**Verify against the three real defects from v1's session**, not invented
ones:

1. a decision to use `.mjs` where the test script globs `.js`;
2. tests written at the repository root, where the glob cannot see them;
3. an assertion that would have failed had it ever run.

Every one passed every automatic check. **A Reviewer that does not
escalate all three is not finished.**

**Size:** ~350 lines. **The productivity claim rests here.**

---

## M4 — Reversibility and the record

Recovery snapshots for every applied change, `undo <id>` at any time, and
an append-only record of what was attempted, what was proved, what failed
and why.

Observability is the point, not evidence for third parties. v1 spent
3,470 lines — 13% of the tree — on HMAC chaining, signing, export bundles
and receipts, and in forty days the only thing that read it was one
diagnosis. **Keep the record, drop the cryptography** until something
needs it.

**Verify:** undo any change at any point, including after later changes
touched the same files.

**Size:** ~500 lines.

---

## M5 — The operator surface

```
add <item>       feature-list item: criteria and MoSCoW priority
work             take the next Must; build, prove, review; apply or escalate
look             what happened, what is pending, what escalated and why
show <id>        the exact diff, when you want it
undo <id>
```

Five verbs. Built last because M1–M4 will change what it should say.

**Verify:** an application built start to finish by someone following
nothing but `look`.

**Size:** ~800 lines. **Running total: ~4,100.**

---

## How success is measured

From the machine's own record, not impressions:

| | v1 baseline | v2 target |
|---|---|---|
| application lines shipped per day | 76 | 10× or the bet failed |
| escalations per change | 1.0, by construction | **< 0.33** |
| defects reaching the repository | 0 | ≤ 1 per 20 changes, all reversed |

## Kill criteria

- **After M1**, escalations not clearly below one per change — the
  inversion bought nothing.
- **After M3**, the Reviewer misses any of the three real defects and no
  prompt change fixes it — machine review cannot substitute for human
  review, which is the whole premise.
- **At any point**, a change lands that the gates should have caught and
  `undo` cannot reverse — reversibility is the floor the weaker guarantee
  stands on.

## Not built

Sealed read scopes, turn budgets, a skill catalog, a four-stage workflow,
build plans, dependency installation, the workspace file world, project
registries, signed evidence export, Pi extensions, sub-agents, graph
orchestration, sprints, stand-ups and stakeholder roles.

Each was either measured as cost in v1, or coordinates nobody when there
is one operator. Graph orchestration and richer topologies are the
direction v1 over-invested in; two agents and the gates first.

## First action

M0. The threat model before any code that lets the model write.
