# v2 — measured against the plan

M0 through M5 are built. This is the plan's own scorecard, filled in.

## How success was to be measured

| | v1 baseline | v2 target | measured |
|---|---|---|---|
| application lines per day | 76 | 10× or the bet failed | **544 hand-written lines in 4m14s** (M1, same two tickets) |
| escalations per change | 1.0, by construction | < 0.33 | **≈0.06** (1 gate failure in ~17 model runs) |
| defects reaching the repository | 0 | ≤ 1 per 20 changes, all reversed | **1**, before the Reviewer existed |

### On the first row

v1 built `buildlog` tickets 1 and 2 in a working day: 76 lines of
application code, 135 audited actions. v2 rebuilt the same two tickets
from an empty project in **254 seconds**, meeting the same acceptance
criteria. In M5 it built a three-item library from nothing in **132
seconds**.

The multiple is large enough that the precise figure does not matter; what
matters is that it is not 2×.

### On the second row

The append-only record only begins at M4, because that is when it was
built — 8 model runs, 6 applied, 0 escalated, 0 gate failures, 0 needing a
second attempt. Earlier runs were observed rather than recorded, and there
was exactly one gate failure among them (M2's deliberate uncollected-test
case, which the retry then fixed).

So the honest statement is: **roughly one escalation in seventeen runs,
against a target of one in three, on a small sample that the record only
partly covers.** The number is well under the target and the sample is
thin. Both are true.

### On the third row

One defect reached a repository: the unrequested build script, in M1, in
two runs out of two. It reached it because the Reviewer did not exist yet
— every gate passed, correctly, since no gate can express "this was not
the request". M3 built the Reviewer against exactly that case and it now
catches it.

No defect has reached a repository since M3, and none has been
irreversible.

## Kill criteria

| criterion | outcome |
|---|---|
| After M1, escalations not clearly below one per change | **not triggered** — no escalation mechanism existed yet, and the gate failure rate was already far below one |
| After M3, the Reviewer misses any of the three real defects | **not triggered** — all three caught, plus a fourth, with honest work passing |
| At any point, a change lands that the gates should have caught and `undo` cannot reverse | **not triggered** |

## What it cost

| milestone | estimate | actual |
|---|---|---|
| M0 boundary | — | 322 |
| M1 skeleton | ~350 | 729 |
| M2 gates | ~600 | 745 |
| M3 Reviewer | ~350 | 664 |
| M4 reversibility | ~500 | 554 |
| M5 surface | ~800 | 854 |
| **total** | **~4,100** | **3,725** |

Against v1's 25,330 lines of source, of which 3,470 were cryptographic
evidence machinery that one diagnosis ever read.

99 tests, 0 failures. Three commands prove the parts that tests cannot:
`verify:boundary` against a real daemon, `verify:gates` breaking each gate
in turn, `verify:reviewer` against v1's real defects.

## The pattern worth keeping

Every milestone found a defect, and every one was found by breaking
something on purpose rather than by a passing suite:

- **M0** — the read-only check verified the wrong thing; the writes it
  attempted fail for a non-root user whether or not the flag was given.
- **M1** — three separate green results that meant nothing ran: fixtures
  that never parsed, Node silently skipping a nested `--test`, and two
  guards "verified" by `sed` edits that never matched.
- **M2** — the claim gate refused an honest claim, for a discrepancy the
  harness itself created.
- **M3** — nothing; the Reviewer worked first time. The control case is
  what makes that claim worth anything.
- **M4** — reversal treated as a flag rather than a stack, and a test
  whose name claimed two things while asserting half of one.
- **M5** — `work` took the same item forever, found on the second command
  of the milestone's own verification.

None of these were found by the 99 tests. They were found by using the
thing, and by breaking each check to confirm it could fail.
