# The console

`harness view` renders the record as a page. This plans what it becomes:
a window onto a build you can read while it happens, and afterwards.

Everything here is obtainable. Pi's `--mode json` was tested against a
real run and emits provider, model, per-turn token counts split by
input / output / cacheRead / cacheWrite / reasoning, and cost in dollars,
alongside `turn_start` / `message_update` / `turn_end` events as work
proceeds. Nothing below needs estimating.

## Three stages, each useful alone

### S1 — Capture and record

**~200 lines.** The foundation, and the only risky part.

Switch the builder from `--print` to `--mode json`, parse the event
stream, and record on each run: provider, model, tokens by kind, cost,
and per-turn timings. Show them in `view`.

**The risk is the terminal, not the data.** `--mode json` replaces Pi's
human-readable streaming with events, so the harness has to re-render
progress itself. Done well that is an improvement — structured turns
instead of raw text. Done badly it takes away the running commentary you
have now and gives back less.

**Verify:** a run's recorded token total matches the sum of its turns,
and the terminal output is no less useful than today's. If the second
cannot be met, keep `--print` and capture usage from the session file
instead.

### S2 — The project, browsable

**~250 lines.** No server.

The project tree in the page: click any file, read it, see which runs
touched it and jump to those diffs. Everything is already on disk.

**Verify:** a file changed by three runs lists all three, and a file no
run has touched still opens.

### S3 — Live

**~300 lines.** The only stage that needs a server.

`harness view --serve` — a read-only local server, so the page can poll
while a run is in flight: which item, which turn, tokens so far, elapsed
time, and each gate as it reports.

A `file://` page cannot poll local files; browsers block it. That is the
whole reason this stage differs from the other two.

**It stays read-only.** It starts no container, calls no model, applies
nothing, and binds to loopback only. The harness writes a status file as
it works; the server reads it. There is no route from the page back into
a run.

**Verify:** kill the harness mid-run and the page says the run stopped
rather than showing it as permanently in progress.

## What it must not become

**Not a way to drive the harness.** No buttons that start runs, apply
changes, or approve escalations. Those decisions belong in a terminal
where they are typed deliberately, and a console that can act is a
console that can act by accident.

**Not a second source of truth.** The page renders `record.jsonl` and the
recovery snapshots. It stores nothing of its own and computes nothing the
record does not already contain.

**Not trusted input.** Everything it renders — file contents, criteria,
the reviewer's words — comes from a project a model has been writing in.
All of it is escaped, and that is the reason a viewer which runs nothing
is safe to look at.

## Order

S1 first: it is the foundation and carries the one real trade-off. S2 is
straightforward and independent. S3 last, and only if watching a run
matters more than reading it afterwards.
