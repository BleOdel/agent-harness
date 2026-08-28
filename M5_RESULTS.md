# M5 — the operator surface

```
npm run add  -- <id> --title "..." --criterion "..." [--priority must]
npm run work [-- <item-id or goal>]
npm run look
npm run show -- <run-id>
npm run undo -- <run-id>
```

Five verbs. `work` with no argument takes the next Must.

## The verification

> **Verify:** an application built start to finish by someone following
> nothing but `look`.

From an empty directory, following only what `look` printed:

```
look          "No feature list. Add an item: npm run add -- <id> ..."
add × 3       temperature (must), length (should), index (could)
look          "Next: temperature. Start it with: npm run work"
work          taking the next must: temperature   → applied as r1   40s
work          taking the next should: length      → applied as r2   39s
work          taking the next could: index        → applied as r3   53s
work          "Nothing left to work on."
```

**132 seconds**, three items, in MoSCoW order, stopping cleanly. The
result is a working library: 7 tests passing, `celsiusToFahrenheit(100)`
returns `212`, `metresToFeet(1)` returns `3.2808`.

## What the verification found

It found the thing it was designed to find, on the second command.

**`work` took `temperature` three times in a row.** Nothing marked an item
done, so `nextItems` returned the same Must forever. Following only
`look`, the operator could never reach item two — the exact failure the
plan's verification was written to catch, and invisible to every test in
the suite.

The harness now writes `status`, and only `status`. Never a title, never a
priority, never a criterion. The rule that matters is that nothing being
judged may edit what it is judged against, and status is not that: it is
the harness recording a verdict its own gates and Reviewer reached.

**Then undo broke the story.** Undoing the run that built `temperature`
removed the files and left the item reading `done` — `look` describing
work whose code had just been deleted, which is the one thing a record
exists to prevent. Status now travels the same round trip the files do:
undoing a run reopens its item, and undoing *that* undo closes it again.
`look` also checks whether a run is still standing before calling it
applied, rather than reporting a repository that no longer exists.

**And undo says what it did not do.** "The suite was not re-run. Check it
before working on top of this." Undoing `temperature` while `index.js`
still re-exported it left the suite failing — correct behaviour for a verb
that reverses exactly one run, and worth saying out loud rather than
leaving the operator to discover.

## A refactor with a reason

Every verb is now a module that has to be called, and `src/cli.ts` is the
only file in the project that does anything when you load it. This project
learned that lesson twice — M0's boundary probe and M4's `planUndo` — both
times by writing a test that ran the command instead of testing it.

The move immediately broke the path to the assertion counter, built from
the caller's directory rather than from the module that owns the file. It
failed live with `ENOENT` and nothing in 97 tests caught it. There is now
a test that the gate can find the file that makes it work.

## Totals

| | estimate | actual |
|---|---|---|
| M5 | ~800 | 854 |
| project | ~4,100 | 3675 |

99 tests, 0 failures.
