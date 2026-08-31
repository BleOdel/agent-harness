# agent-harness

A coding agent that works in a sandbox, proves what it built, then applies
it — or escalates to you.

```
npm run add  -- feed --title "RSS feed" --criterion "feed.xml is generated from site data"
npm run work
```

```
taking the next must: feed
tests: passed, 139 assertions executed
test collection: all 12 test files are collected
build: reproducible, committed artefacts match their sources
size: 10 files, 430 lines, within ceilings
claim: all 5 criteria point at real files
boundary: 10 files, all inside the project
review: passed, 5 criteria accounted for
  added    feed.xml
  added    src/render-feed.js
  ...
applied as r5. undo with: npm run undo -- r5
```

## The guarantee

> **The model works only on a copy. Nothing reaches your repository until
> the machine has proved it, and nothing that reaches it is irreversible
> or unrecorded.**

This is deliberately *not* "the model cannot act". The predecessor to this
project put a human approval in front of every byte the model wrote. It
worked, and it produced **76 lines of application code in a full working
day** across 135 approvals. Human review in the critical path is both the
guarantee and the ceiling.

So the trade here is explicit: the model reads what it needs and writes
what it likes, inside a container it cannot escape, and the burden moves
from *approving every change* to *proving every change and being able to
reverse it*. `THREAT_MODEL.md` states what that costs, including the six
residual risks, first among them that the whole guarantee rests on one
container boundary.

## Architecture

The container is the whole guarantee. Everything else exists to decide
what may cross back out of it.

```mermaid
flowchart TB
    P[("your project<br/>never mounted, never writable")]

    P -. "copy — .git, features.json<br/>and secrets withheld" .-> C

    subgraph BOX["one container: non-root · read-only rootfs · no capabilities · no host filesystem · no Docker socket"]
        direction TB
        C["the disposable copy<br/>the only writable mount"]
        B["Pi — builder<br/>tools on · provider network"]
        G["six gates<br/>no network at all"]
        V["Pi — reviewer<br/>read-only · own process · no shared context"]
        C <--> B
        B --> G
        G --> V
    end

    G -. "a gate fails" .-> D["named diagnosis<br/>what failed · why it matters<br/>what would count as fixed"]
    D -. "one more attempt" .-> B

    V -- "escalate" --> E["stops.<br/>nothing applied"]
    V -- "pass" --> A["snapshot before and after,<br/>then apply"]
    A --> W[("your project, changed<br/>+ one line in the record")]
```

`undo r1` reverses any of it later, three ways, keeping whatever ran after.


Three things that diagram is making precise:

- **Your project never enters the container.** A copy does. That is what
  lets the model have real tools without the blast radius.
- **The gates have no network.** A verification that can reach the network
  can pass because a service was up and fail because one was down, and
  neither outcome is about your change.
- **The reviewer is a separate process, not a sub-agent.** One running
  inside the builder's session would already believe every justification
  that produced the diff.

## Requirements

- **Node ≥ 26** — the harness runs TypeScript directly by type-stripping;
  there is no build step and no runtime dependency.
- **Docker**, with a Linux daemon.
- **[Pi](https://github.com/earendil-works/pi)**, installed
  and authenticated with a provider. Pi supplies the agent loop; this
  project supplies the boundary, the gates, the reviewer and the record.

## Setup

```bash
npm install && npm link
cp .env.example .env      # then edit it
```

`npm link` puts `harness` on your PATH so you run it inside your own
project. Settings are read from `~/.config/harness/config` or the
harness's own `.env` — never from the project directory, because a
project is a place a model has been writing and config decides how a run
is contained.

`.env.example` explains every value. The three that are required —
the container image, Pi's package directory, and Pi's data directory — are
refused loudly with a remedy if they are missing, rather than defaulted.

Then prove the boundary is real, against your actual Docker daemon:

```bash
npm run verify:boundary
# boundary verified: non-root, no host filesystem, no capabilities,
# no Docker socket, read-only container, writable copy only
```

## Dependencies

You install them; the harness never does on its own. `node_modules` is
copied into the sandbox so the tests can run, and the gates run with **no
network at all**, so nothing can be fetched during verification.

`node_modules` is also never applied back — it is generated, and npm
touches it merely by running. That leaves one gap, and `harness deps`
closes it: a run that installs a package inside the sandbox brings back
the `package.json` declaration without the package. Every gate passes
there, where it exists; on your machine the project would not run.

So `work` checks after applying, and says so:

```
applied as r4. undo with: harness undo r4

This run declared zod, which is not installed here.
Install with:  harness deps --install
```

`harness deps` on its own only reports. `--install` runs `npm install` in
your project — **the one command in this tool that reaches outside a
container**, which is why it takes a deliberate second word. Installing a
package runs whatever install scripts it ships, with your permissions,
outside every boundary the rest of this maintains.

## Extensions

Off, always, for both agents — `--no-extensions`.

Pi discovers extensions from its own data directory, which the harness
mounts writable, and an extension can register tools and flags. The whole
argument here rests on knowing what the model can do, and "whatever
happens to be installed" is not knowing. The harness previously said
nothing either way, which meant discovery was live and silent.

If they are ever wanted they get the same treatment skills did: a
read-only mount, off by default, named in the output.

## Skills

Pi loads skills — directories containing a `SKILL.md` — and the harness
can mount a directory of them into the builder, read-only:

```bash
HARNESS_SKILLS=~/Developer/agent-skills npm run work
```

```
skills: codebase-design, diagnosing-bugs, domain-modeling, tdd
```

Loading is deliberate in both directions. With no directory configured,
the harness passes `--no-skills` rather than leaving Pi's own discovery to
find whatever happens to be installed in its data directory — which is
mounted writable, so something could appear there without anyone deciding
it should. What loads is printed by name.

**The reviewer never gets skills**, even when the builder does. Its job is
fixed, and a skill could redefine what it finds acceptable — the one
opinion here that must not depend on what is installed.

**A skills directory inside the project is refused**, because it would be
in the copy too, where the model could rewrite the instructions it is
then given.

Only skills that work without a human are worth mounting. The interview
and planning ones — anything marked `disable-model-invocation` — need
someone to answer, and there is nobody inside the container.

## The seven verbs

Run them inside your project.

| | |
|---|---|
| `harness init` | create a project the gates can work with |
| `harness plan [<topic>]` | an interview, in the sandbox, to settle criteria |
| `harness add <id> …` | put an item on the feature list |
| `harness add --from latest` | import the items a plan proposed |
| `harness work [<id>]` | build the next Must, or a named item |
| `harness look` | what happened, what is pending, what escalated and why |
| `harness show <run-id>` | the exact diff a run applied |
| `harness view [--open]` | the whole record as a page you can read |
| `harness undo <run-id>` | put it back |
| `harness run [--max N]` | work items until one needs you |
| `harness commit [<run-id>]` | commit what a run applied — never pushes |
| `harness deps [--install]` | packages a run declared but did not install |
| `harness remove <path> --yes` | a project and its harness state, together |

`work` with no argument takes the next Must from `features.json`. The
project is the directory you are in, or `HARNESS_PROJECT` if you set it.

## Start to finish

```bash
mkdir ~/Developer/site && cd ~/Developer/site
harness init
harness plan "what this website should be"
harness add --from latest
harness work
```

### The chain

```
plan  ──►  PLAN.md + items.json  ──►  add --from  ──►  features.json  ──►  work
interview      the interview's         you read it        the backlog        build
               conclusions,            and accept
               machine-readable
```

`plan` writes its work items twice: as prose in `PLAN.md`, and as JSON in
`items.json`. Import the second rather than retyping the first:

```bash
npm run add -- --from <project>-harness/plans/<stamp>/items.json
```

**The model still never writes `features.json`.** It proposes; you run the
command that accepts. That is the same shape as `work` — propose inside
the sandbox, then a gate before anything lands — except the gate here is
you reading the list. Read it: a proposal comes from a model that has just
spent an interview agreeing with you.

A proposed `status` is discarded rather than trusted. Status is the
harness's own verdict, reached through the gates and the reviewer, and an
item importable as already done would let a model mark its homework before
doing it. An import that clashes with an existing id writes nothing at
all, rather than landing half a backlog.

### Why there is a sixth

The plan said five, and the sixth earns the exception by closing a gap the
five could not. `work` demands acceptance criteria and offers no help
writing them, while everything downstream — the reviewer's judgement,
whether an escalation means anything — rests on how good they are. `add`
takes whatever string you type.

`plan` runs Pi **interactively**, with your terminal attached to the
container, so an interview skill can ask a round of questions and wait for
your answers. `work` cannot do this: it runs with `--print`, one prompt in
and one answer out, with nobody to wait for.

Nothing a `plan` run does is ever applied. The model works in a disposable
copy and writes one file, collected to `<project>-harness/plans/` rather
than into the project. A plan is a document to argue with, not a change,
and it faces none of the gates because it changes nothing they could
check.

The containment is identical to every other run — verified by asserting
that an interactive argument list differs from a one-shot one by exactly
`--interactive` and `--tty` and nothing else.

## How a run works

1. **Copy.** Your project is copied into a disposable sandbox. The
   project itself is never mounted. Withheld from the copy, and announced
   rather than dropped silently: `.git`, `features.json`, `.harness`,
   `.secure-harness`, `.env`, `.env.local`, `.ssh`, `.aws`, `.gnupg`,
   `.npmrc`, `.netrc`.
2. **Build.** Pi runs in the container with tools enabled and the
   provider's network. It reads what it needs and writes what it likes —
   to the copy.
3. **Prove.** Six gates, with no network at all. The first answers two
   questions, and the second is the one people forget to ask:

   - the test suite passes;
   - **assertions actually ran** — a suite that asserts nothing has not
     passed in any sense you care about;
   - every test file is one the runner actually collects;
   - the project typechecks, where it declares a typecheck;
   - the build is reproducible, so committed artefacts match their sources;
   - the change is within its ceilings;
   - the claim the model wrote matches what actually changed.

   A failing gate hands the model a **named diagnosis** — what failed, why
   it matters, what would count as fixed — and it gets one more attempt.
   Never a log to guess from.
4. **Review.** A second Pi process, read-only, no shared context with the
   builder, judges the diff against the item's acceptance criteria. It
   answers two questions: is each criterion actually satisfied, and is
   anything here unaccounted for? It passes silently or escalates to you.
5. **Apply.** With a recovery snapshot of both sides, and a line in an
   append-only record.
6. **Destroy.** The sandbox goes, on every path, including a crash.

## Running unattended

```bash
harness run --max 5
```

Works items until the queue empties or **something needs a person** —
an escalation, a gate that failed twice, an empty queue. It stops there
rather than starting the next item on top of an unexamined one. That is
the whole discipline: an escalation nobody reads while later work builds
on it is exactly the failure the reviewer exists to prevent, and
automating past it would undo the point.

It is safe to run unattended only because every guarantee holds per item.
Each is copied, gated, reviewed, snapshotted and applied on its own, so
five items are five of those rather than one large one.

## Git

The model never sees git. `.git` is not in the sandbox copy, so history
cannot be rewritten, a branch cannot be moved, and no commit can be made
that looks like yours.

`harness commit` runs on the host, when you ask, and only ever adds a
commit — no push, no branch, no amend. The message records what the work
was meant to satisfy and what proved it:

```
Truncate text to a length

Applied by the harness as r2.

  tests: passed, 6 assertions executed
  test collection: all 3 test files are collected
  claim: all 3 criteria point at real files
  review: pass
```

Six months later the useful question about a commit is not what changed —
the diff says that — but what it was supposed to satisfy.

## Why the Reviewer exists

Every gate above asks whether the code is *sound*. None can ask whether it
is the work you *asked for*. Measured: in two runs out of two, the model
shipped a build script and an `npm run build` that no acceptance criterion
mentioned. Every gate passed, correctly.

The Reviewer is checked against the four defects that actually happened,
not invented ones:

```bash
npm run verify:reviewer
```

```
CAUGHT  1. .mjs where the test script globs .js
CAUGHT  2. tests at the repository root, where the glob cannot see them
CAUGHT  3. an assertion that would have failed had it ever run
CAUGHT  4. scope creep: a build step nobody asked for
PASSED  control: honest work that asks for nothing extra
```

The control is not optional. "Caught all four" proves nothing about a
reviewer that escalates everything, and a reviewer that escalates
everything is one you learn to ignore.

## What a run cost

Every run records the model, its token counts split by kind, and the cost
in dollars. `work` prints one line as it finishes and `look` keeps a
running total:

```
model: gpt-5.6-sol · 10 turns · 41,175 tokens · 61% cached · $0.1243
...
HISTORY  2 runs, 2 still standing  ·  107,078 tokens, $0.31
```

This comes from Pi's `--mode json` event stream rather than being
estimated, and the harness renders the readable commentary back out —
prose as it streams, tool calls named rather than dumped, and anything
that is not JSON passed through untouched so a warning is never
swallowed.

Two things the numbers get right that are easy to get wrong. Usage is
summed from `turn_end` only: the same figures appear on five other event
types, and counting more than one multiplies a turn by how often its
partial state was reported. And `input` is the *non-cached* share of the
prompt — `totalTokens = input + output + cacheRead` — so the cached
percentage is measured against the whole prompt. Measuring it against
`input` alone reported "207% cached" on the first live run.

Runs recorded before this existed have no usage, and `look` says so
rather than quietly totalling half the history.

## Reading what happened

```bash
harness view --open
```

`show` prints a diff to a terminal, and on a real run that was 1,526
lines. Nobody reads that — which means the one human check in this design
quietly does not happen. The information was never the problem; the shape
of it was.

`view` writes the record as a single HTML file: every run, its gate
verdicts, the Reviewer's findings, each file's diff separately and
collapsible with the acceptance criteria above them, and the project's
own files down the side — click one to read it, with a link to every run
that changed it. Runs reversed by a
later undo are marked as such rather than shown as though they still
stand.

File contents are carried in the page rather than fetched, because a
`file://` page cannot read its neighbours. That puts a ceiling on it, so
the ceiling is explicit: a file too large or binary is still *listed*,
with the reason it is not shown. A tree that hid what it could not carry
would misdescribe your project rather than the page.

**It runs nothing.** No server, no container, no model, no credentials —
it turns files already on disk into HTML. Everything it shows comes from
`record.jsonl` and the `before`/`after` copies in `recovery/`. That is why
it needs no permission and why there is nothing in it to trust.

Everything it renders — file contents, criteria, the Reviewer's words —
comes from a project a model has been writing in, so all of it is escaped.
A viewer that executed any of it would be a route out of the sandbox
through the one tool that was supposed to be safe precisely because it
runs nothing.

## Undo

`undo` reverses one run at any point, **including after later runs changed
the same files**. Every run snapshots both what was there before and what
it left behind, so undoing is a three-way merge rather than a restore:
later work is kept, and where the undo and later work rewrote the same
lines, nothing is written and the conflict is named.

An undo is itself a run, with its own snapshot, so it can be undone in
turn.

## Verifying it yourself

```bash
npm run check             # typecheck and the unit suite — needs nothing but Node
npm run verify:boundary   # the container, against a real daemon
npm run verify:gates      # each gate broken in turn, confirmed to stop the apply
npm run verify:reviewer   # the four real defects, plus the control
```

The three `verify:` commands need Docker, a configured image and a real
model, and each one **fails loudly rather than skipping** when it cannot
run — because a check that skips quietly reads as a pass, and this project
has now shipped that defect twice and caught it twice.

`npm run check` is the exception, deliberately: the unit suite has to run
on a machine with no Docker at all, so the one test that needs a daemon
skips there by name, and `verify:gates` is what refuses to skip it.

## What it deliberately does not have

Sealed read scopes, turn budgets, a skill catalog, sprints and stakeholder
roles, graph orchestration, sub-agents, signed evidence export. Each was
either measured as cost in the predecessor or coordinates nobody when
there is one operator.

The record is append-only JSONL with **no cryptography**. The predecessor
spent 3,470 lines — 13% of its tree — on HMAC chaining, signing and
receipts, and in forty days the only thing that read them was a single
diagnosis. Observability is the requirement here; tamper-evidence is a
different requirement with a different threat model, and can be added when
something needs it.

## Reading the work

`V2_RESULTS.md` is the scorecard against the original plan. The milestone
write-ups — `M1_RESULTS.md` through `M5_RESULTS.md` — are worth more than
the code, because each records what building it *found*:

- **M0** — the read-only check verified the wrong thing; the writes it
  attempted fail for a non-root user whether or not the flag was given.
- **M1** — three separate green results that meant nothing had run.
- **M2** — the claim gate refused an honest claim, for a discrepancy the
  harness itself created.
- **M4** — reversal treated as a flag rather than a stack, and a test
  whose name claimed two things while asserting half of one.
- **M5** — `work` took the same item forever, found on the second command
  of that milestone's own verification.

None of these were caught by the test suite. They were found by using the
thing, and by breaking each check to confirm it could fail.

## Predecessor

[`secure-agent-harness`](https://github.com/BleOdel/secure-agent-harness)
is v1: 25,330 lines of source, human approval in front of every change. This is a
clean-room rebuild sharing no code with it, at 3,725 lines. `SCOPE.md`
explains what was given up and what was gained.
