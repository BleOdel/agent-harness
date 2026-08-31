/**
 * The record, as a page you would actually read.
 *
 * `show` prints a diff to a terminal, and on a real run that was 1,526
 * lines. Nobody reads that, which means the one human check in this
 * design quietly does not happen. The information was never the problem;
 * the shape of it was.
 *
 * Reads only. It starts no container, calls no model, applies nothing and
 * needs no credentials -- it turns files already on disk into HTML. That
 * is why it needs no permission and nothing to trust.
 */

import type { RunRecord } from "../record/record.ts";

export interface FileDiff {
  readonly file: string;
  readonly kind: string;
  /** Prefixed lines: "+", "-", or " ". Empty when there was nothing to show. */
  readonly lines: readonly string[];
  /**
   * Shown beneath the lines. Says when there is nothing to show, and when
   * what is shown is only part of it -- a reader given a fragment and not
   * told will read it as the whole.
   */
  readonly note?: string | undefined;
}

export interface RunView {
  readonly run: RunRecord;
  readonly title: string | undefined;
  readonly criteria: readonly string[];
  readonly files: readonly FileDiff[];
  readonly standing: boolean;
}

/** Anything from the project could contain markup; none of it is trusted. */
export function escape(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const OUTCOME_LABEL: Record<string, string> = {
  applied: "applied",
  escalated: "escalated to you",
  "gate-failed": "stopped by a gate",
  "no-changes": "no changes",
  error: "error",
};

function diffBlock(file: FileDiff): string {
  if (file.lines.length === 0) {
    return `<p class="note">${escape(file.note ?? "No textual change.")}</p>`;
  }
  const rows = file.lines.map((line) => {
    const mark = line.slice(0, 1);
    const cls = mark === "+" ? "add" : mark === "-" ? "del" : "ctx";
    return `<div class="l ${cls}">${escape(line)}</div>`;
  });
  const added = file.lines.filter((l) => l.startsWith("+")).length;
  const removed = file.lines.filter((l) => l.startsWith("-")).length;
  const note = file.note === undefined ? "" : `<p class="note">${escape(file.note)}</p>`;
  return [
    `<details><summary><span class="path">${escape(file.file)}</span>`,
    `<span class="kind">${escape(file.kind)}</span>`,
    `<span class="counts"><span class="add">+${String(added)}</span> <span class="del">-${String(removed)}</span></span>`,
    `</summary><div class="diff">${rows.join("")}</div>${note}</details>`,
  ].join("");
}

function runSection(view: RunView): string {
  const { run } = view;
  const findings = run.review?.findings ?? [];
  const reversed = run.outcome === "applied" && !view.standing;
  return [
    `<section class="run ${escape(run.outcome)}${reversed ? " reversed" : ""}" id="${escape(run.id)}">`,
    `<header><h2>${escape(run.id)}<span class="goal">${escape(view.title ?? run.goal)}</span></h2>`,
    `<p class="meta">${escape(run.at.slice(0, 16).replace("T", " "))}`,
    ` &middot; <span class="outcome">${escape(OUTCOME_LABEL[run.outcome] ?? run.outcome)}</span>`,
    run.attempts > 1 ? ` &middot; ${String(run.attempts)} attempts` : "",
    run.usage === undefined ? "" : ` &middot; <span class="usage">${escape(run.usage.model ?? "model")}`
      + ` &middot; ${run.usage.totalTokens.toLocaleString("en-GB")} tokens`
      + (run.usage.cacheRead > 0
        ? ` &middot; ${String(Math.round((run.usage.cacheRead
          / (run.usage.input + run.usage.cacheRead)) * 100))}% cached` : "")
      + ` &middot; $${run.usage.costUsd.toFixed(4)}</span>`,
    reversed ? ' &middot; <span class="outcome">reversed by a later undo</span>' : "",
    `</p></header>`,
    view.criteria.length === 0 ? "" : `<div class="criteria"><h3>Acceptance criteria</h3><ul>${
      view.criteria.map((c) => `<li>${escape(c)}</li>`).join("")}</ul></div>`,
    run.gates.length === 0 ? "" : `<ul class="gates">${
      run.gates.map((g) => `<li>${escape(g)}</li>`).join("")}</ul>`,
    findings.length === 0 ? "" : `<div class="findings"><h3>The reviewer said</h3><ul>${
      findings.map((f) => `<li>${escape(f)}</li>`).join("")}</ul></div>`,
    run.reason === undefined ? "" : `<p class="reason">${escape(run.reason)}</p>`,
    view.files.length === 0 ? "" : `<div class="files">${view.files.map(diffBlock).join("")}</div>`,
    `</section>`,
  ].join("");
}

const STYLE = `
:root{--bg:#fbfaf7;--fg:#14171a;--dim:#5f6b72;--line:#e2ded4;--add:#0a7f42;--del:#b3261e;--accent:#1a49c4;--card:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#101315;--fg:#eef1f2;--dim:#93a1a8;--line:#283135;--add:#4ade80;--del:#f87171;--accent:#7aa2ff;--card:#161b1e}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{width:min(100% - 2rem,64rem);margin:0 auto;padding:3rem 0 6rem}
h1{font-size:2rem;margin:0 0 .25rem}
.sub{color:var(--dim);margin:0 0 2.5rem}
.run{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:1.25rem 1.5rem;margin:0 0 1.25rem}
.run.escalated{border-left:4px solid var(--accent)}
.run.gate-failed{border-left:4px solid var(--del)}
.run.reversed{opacity:.55}
h2{font-size:1.05rem;margin:0;display:flex;gap:.75rem;align-items:baseline;flex-wrap:wrap}
h2 .goal{font-weight:400;color:var(--dim)}
.meta{margin:.15rem 0 0;color:var(--dim);font-size:.85rem}
.outcome{color:var(--fg);font-weight:600}
.usage{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}
h3{font-size:.72rem;text-transform:uppercase;letter-spacing:.09em;color:var(--dim);margin:1.25rem 0 .4rem}
.criteria li{margin:.2rem 0}
.gates{list-style:none;padding:0;margin:1rem 0 0;font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim)}
.findings li{margin:.3rem 0}
.reason{font-size:.9rem;color:var(--dim)}
.files{margin-top:1.25rem}
details{border-top:1px solid var(--line)}
summary{cursor:pointer;padding:.55rem 0;display:flex;gap:.75rem;align-items:baseline;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
.path{flex:1;word-break:break-all}
.kind{color:var(--dim);font-size:.78rem}
.counts .add{color:var(--add)}.counts .del{color:var(--del)}
.diff{overflow-x:auto;padding:.4rem 0 .9rem;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
.l{white-space:pre;padding:0 .5rem}
.l.add{background:color-mix(in srgb,var(--add) 12%,transparent)}
.l.del{background:color-mix(in srgb,var(--del) 12%,transparent)}
.l.ctx{color:var(--dim)}
.note{color:var(--dim);font-size:.9rem;margin:.5rem 0}
`;

export function renderPage(project: string, views: readonly RunView[]): string {
  const applied = views.filter((v) => v.run.outcome === "applied" && v.standing).length;
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escape(project)} - harness record</title>`,
    `<style>${STYLE}</style></head><body><main>`,
    `<h1>${escape(project)}</h1>`,
    `<p class="sub">${String(views.length)} runs recorded &middot; ${String(applied)} still standing &middot; read-only</p>`,
    ...views.map(runSection),
    "</main></body></html>",
    "",
  ].join("\n");
}
