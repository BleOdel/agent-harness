# Toward assigned agents

A plan for the work in `Agent_Harness_Team_Implementation_Blueprint.md`,
reordered by what the record can already justify.

The blueprint is sound and its diagnosis of this codebase is accurate —
three of its claims were checked against the source and all three hold.
What follows disagrees with it on one thing only: **the order**. It leads
with parallel builders, and the measurements say that is the part to build
last.

## What the record says

| | measured |
|---|---|
| a narrow item | 5–20¢, 10–14 turns |
| `metadata-privacy` | **$1.08**, 29 turns, 558k tokens |
| `accessible-responsive` | **$1.59**, 46 turns, 1.37M tokens, 94% cached |

Both expensive items had criteria spanning every page. The cost is not the
work — it is context growth, re-read on every turn.

Two consequences, and they point in opposite directions.

**Against parallel builders.** Two builders on a project like this do not
halve the tokens; each carries its own growing copy, so total spend rises
while wall time falls. The blueprint concedes this in one line. On this
evidence the bar it sets — independence exceeding coordination and
integration overhead — is not met by the only real project here.

**For steering.** A 46-turn run costs £1.20 and is fire-and-forget. Being
able to see it going wrong at turn 10 and redirect it is worth more, on
these numbers, than running two of them at once.

## Stage A — fix what is wrong now

**Hours, not days. No team, no new concepts, and worth having regardless
of everything below.**

### A1 · Enforce `dependsOn`

`harness work later-item` prints `note: depends on X, which are not done`
and then runs anyway. A dependency that only warns is a comment.

Both automatic and explicit selection must refuse a task whose
prerequisites are not `done`, name the blocker, and reject cycles with a
readable path.

**Verify:** an explicitly named task with an unmet prerequisite does not
start; a cyclic graph is refused at parse time with the cycle printed.

### A2 · Verify from a clean environment

Gates run in the same copy the builder worked in, with whatever
`node_modules` the builder left behind. A builder that mutated a
dependency can make its own tests pass, and nothing would notice.

Verification should restore dependencies with `npm ci` from the accepted
lockfile, in a fresh sandbox, offline. `npm ci` refuses a
manifest/lockfile mismatch and removes an existing `node_modules`, which
is exactly the property wanted.

**Verify:** a run that corrupts a package inside its copy fails the gates,
where today it passes.

**Kill criterion:** if a clean install cannot be made offline and
repeatable, keep the current behaviour and say plainly in the README that
verification trusts the builder's environment.

### A3 · A structured way to be blocked

There is no `blocked` outcome anywhere. `AGENTS.md` says "stop and say
what blocked you", which puts it in prose, in a transcript. A stuck run
either fails a gate for a misleading reason or ships something wrong.

The claim gains an outcome, and a blocked submission ends the run with the
model's reason surfaced to the operator and recorded — no diff, no
review, no apply.

**Verify:** given an impossible item, the run ends as `blocked` with the
stated reason in `look` and `view`, rather than as a gate failure that
misattributes the cause.

## Stage B — control a run while it happens

**Days. Justified by cost, not by teams.**

### B1 · RPC transport

`run()` gives stdin either `inherit` or `ignore`; neither is a writable
pipe, so RPC is impossible today. A separate long-lived adapter is needed
— request correlation, bounded framing, stdout/stderr separation, event
persistence — with the existing runner kept for finite verification
commands.

Docker needs `--interactive` without `--tty`.

### B2 · Steer and abort

`harness steer "<message>"` and `harness abort`, from a terminal.

**Not from the console.** The page stays read-only: it has no route that
writes, and steering is an action. A console that can act is a console
that can act by accident, and that rule has already survived one attempt
to widen it.

**Verify:** a run heading the wrong way is redirected at turn 10 and
finishes on a different path; an aborted run leaves no container running
and no partial application.

**This stage's real test is arithmetic.** Record cost with and without
steering on comparable items. If steering does not measurably reduce spend
or turn count, Stage C is not worth starting, because its justification is
weaker than this one's.

## Stage C — the team

**Weeks, and only if Stage B pays.**

Built in the blueprint's order, which is right once the decision to build
it is made: host-owned task state and attempt identity; one Pi process per
assignment in its own sandbox; candidate capture against an immutable
baseline; serial integration; bounded repair assignments.

Two things from the blueprint that should not be negotiated down:

**Acceptance belongs to the host.** `agent_settled` means a conversation
ended. It is not a passing task, and no worker-supplied identity may claim
another task's authority.

**A candidate is verified in a fresh environment against the baseline it
started from**, never against the moving live project, and never with the
builder's own `node_modules`.

**Kill criterion:** if a two-builder run on a real project does not beat
the same project built sequentially on wall time — measured, with total
model spend across every role recorded — stop and keep the sequential
harness. The blueprint's own condition, held to.

## What is not planned

**A planner agent.** `harness plan` already fills that role with a human
answering. Criteria quality is what every later judgement rests on, and a
model interviewing itself produces criteria that sound exact and are not.

**Subagents via the Pi extension.** Child processes inherit the parent's
environment, so its isolated contexts are context isolation, not a
security boundary. Useful as a reference for RPC and streaming; not the
mechanism.

**A second console.** Team status belongs in `look` and `view`, which
already read the record.

## The shape of the risk

This harness is 6,699 lines. Stage C plausibly adds four to six thousand
more, roughly doubling it. Its predecessor died at 26,000 lines with 13%
spent on evidence machinery that one diagnosis ever read.

The blueprint is far more disciplined than that predecessor was, and its
estimate — 15–25 focused days — is honest. But every defect found in this
project so far came from *using* it rather than from its 184 tests, and
Stage C is a large amount of code to write before the first real use.

Stages A and B are cheap, fix things that are wrong today, and produce the
measurement that says whether Stage C is worth starting.
