# M4 — reversibility and the record

> Historical sequential-v2 results. Counts, capabilities and limitations below
> describe that milestone, before the team M0–M6 implementation. See
> [README.md](README.md) for current behavior and [TEAM_PLAN.md](TEAM_PLAN.md)
> for the completed team milestones.

```
npm run undo              # what can be undone
npm run undo -- r1        # reverse one run
```

## The requirement, and what it actually took

> **Verify:** undo any change at any point, including after later changes
> touched the same files.

The easy half is a file nobody has touched since: restore the snapshot.
The half that matters is a file later work also edited, and the first
implementation refused it — correctly, and uselessly.

Every applied run now snapshots **both** sides: what was there before, and
what the run left behind. That second one is the base a three-way merge
needs. Undoing means moving the file from *what the run produced* to *what
preceded it*, while keeping everything later runs did.

Live, on a real project built by the harness:

```
run r1   adds whisper() to src/text.js and a test
run r2   adds reverse() to the same two files
undo r1  →  merged  src/text.js        (1 later edit kept)
            merged  test/text.test.js  (2 later edits kept)
```

`whisper` is gone from both files, `reverse` survives, the import line is
correctly rebuilt as `{ reverse, shout }`, and the suite passes.

### The line-granularity problem

That import line was, at first, a conflict — both runs rewrote it, so a
line-level merge refuses, exactly as `git` would. It is also the single
most common shape a real conflict takes: an import list, an export list,
an array of names. Refusing it would have made `undo` useless on precisely
the changes people want to undo.

So a **one-line-for-one-line** collision is retried at token granularity by
the same algorithm. Anything wider is a real disagreement about structure
and stays a conflict.

The retry must not recurse. It did, and two edits changing `30` to `90`
and `10` merged cleanly into something neither side wrote — caught by the
test that insists a genuine disagreement stays a conflict.

**A conflict writes nothing at all.** Not one file, not partially. A
half-undone change leaves the project in a state that never existed and
that nothing can describe.

## The record

Append-only JSONL beside the project: id, time, goal, attempts, outcome,
every gate verdict, the review verdict, and the change set.

No HMAC chain, no signatures, no export bundles, no receipts. v1 spent
3,470 lines — 13% of its tree — on those, and in forty days the only thing
that ever read them was one diagnosis. Observability is the requirement;
tamper-evidence is a different requirement with a different threat model,
and it can be added when something needs it.

Two properties the record does hold:

- **Nothing is ever edited in place.** An undo is a new line, not a flag
  on an old one. A file that gets rewritten has whatever history was
  written last, which is no history.
- **An unreadable line is reported, and still consumes an id.** A record
  that quietly drops what it cannot parse is a record that says a run
  never happened — and reusing the id would give two runs one recovery
  directory, where the second silently overwrites the first.

## What building it found

**Reversal is a stack, not a flag.** The first version marked a run
reversed and left it that way, so undoing an undo could not put the
original back — and the undo itself was un-undoable, despite the module
documenting exactly that. Worse, the test named *"an undone run stops
being undoable, and the undo itself is"* asserted only that the list was
empty, which is also what the bug produces. The name claimed two things
and the assertion checked half of one.

**A module that runs on import cannot be tested.** `planUndo` started
inside `src/undo.ts`, which calls `main()` at load, so importing it ran
the command. That is the second time in this project — M0's boundary probe
was the first. Anything worth testing does not live in a file that does
something when you load it.

87 tests, 0 failures. 554 lines against a ~500 estimate.
