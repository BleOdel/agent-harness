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
import type { ProjectTree } from "./files.ts";

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
.strip{display:flex;gap:2.5rem;flex-wrap:wrap;align-items:flex-start;background:var(--card);
  border:1px solid var(--line);border-radius:10px;padding:1rem 1.5rem;margin:0 0 2rem}
.cell{display:flex;flex-direction:column;gap:.15rem}
.cell .k{font-size:.66rem;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
.cell .v{font:17px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}
.cell .v small{color:var(--dim);font-size:.7rem;margin-left:.35rem}
.partial{flex-basis:100%;margin:.35rem 0 0;color:var(--dim);font-size:.78rem}
.shell{display:grid;grid-template-columns:17.5rem minmax(0,1fr);gap:1.75rem;align-items:start}
@media(max-width:820px){.shell{grid-template-columns:1fr}}
aside{position:sticky;top:1rem;max-height:calc(100vh - 2rem);overflow:auto}
@media(max-width:820px){aside{position:static;max-height:22rem}}
.side-h{font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin:0 0 .5rem}
.tree{list-style:none;margin:0;padding:0;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
.tree .dir{color:var(--dim);font-size:.7rem;letter-spacing:.06em;padding:.75rem 0 .15rem;word-break:break-all}
/* box-sizing after all:unset -- the reset wipes it back to content-box,
   so width:100% plus padding overflowed the sidebar by exactly the
   padding and clipped the right-hand column. */
.tree button{all:unset;box-sizing:border-box;cursor:pointer;display:flex;gap:.5rem;width:100%;align-items:baseline;padding:.12rem .25rem;border-radius:3px;color:var(--fg)}
.tree button:hover{background:var(--line);color:var(--accent)}
.tree button:focus-visible{outline:2px solid var(--accent);outline-offset:1px}
.tree button[aria-expanded="true"]{background:var(--line);color:var(--accent)}
.fname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fruns{color:var(--dim);font-size:.72rem;flex:none;width:1.5rem;text-align:right}
.untouched{color:var(--line)}
.omitted{color:var(--dim);font-size:.75rem;margin:.75rem 0 0}
.panel{background:var(--card);border:1px solid var(--line);border-radius:10px;margin:0 0 1.25rem;overflow:hidden}
.panel header{display:flex;gap:1rem;align-items:baseline;padding:.7rem 1.25rem;border-bottom:1px solid var(--line);flex-wrap:wrap}
.fpath{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;flex:1;word-break:break-all}
.who{color:var(--dim);font-size:.78rem}
.who a{color:var(--accent)}
.panel .src{margin:0;padding:.85rem 1.25rem;overflow-x:auto;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}
.col{min-width:0}
`;

/**
 * The tree, and every file's contents, carried in the page.
 *
 * Contents are hidden panels rather than fetched on demand: a `file://`
 * page cannot read its neighbours, so anything not embedded is not
 * available at all.
 */
function fileBrowser(tree: ProjectTree): string {
  if (tree.files.length === 0) return "";
  const rows: string[] = [];
  let directory: string | undefined;
  for (const [index, file] of tree.files.entries()) {
    if (file.directory !== directory) {
      directory = file.directory;
      rows.push(`<li class="dir">${escape(directory === "" ? "/" : directory)}</li>`);
    }
    // A count, not a list. Run ids beside the filename kept overflowing
    // the column and printing a truncated list that read as the whole one
    // -- and the full set is in the panel, which is where anyone asking
    // "which runs" is going next anyway.
    const runs = file.touchedBy.length === 0
      ? '<span class="untouched" title="never changed by a run">&mdash;</span>'
      : `<span title="changed by ${escape(file.touchedBy.join(", "))}">${String(file.touchedBy.length)}</span>`;
    rows.push(
      `<li><button type="button" data-file="f${String(index)}">`
      + `<span class="fname">${escape(file.name)}</span>`
      + `<span class="fruns">${runs}</span></button></li>`,
    );
  }

  const panels = tree.files.map((file, index) => {
    const links = file.touchedBy.length === 0
      ? "never changed by a run"
      : `changed by ${file.touchedBy.map((id) => `<a href="#${escape(id)}">${escape(id)}</a>`).join(", ")}`;
    const body = file.text === undefined
      ? `<p class="note">${escape(file.note ?? "Not available.")}</p>`
      : `<pre class="src">${escape(file.text)}</pre>`;
    return `<article class="panel" id="f${String(index)}" hidden>`
      + `<header><span class="fpath">${escape(file.path)}</span>`
      + `<span class="who">${links}</span></header>${body}</article>`;
  });

  return [
    `<p class="side-h">Files</p>`,
    `<ul class="tree">${rows.join("")}</ul>`,
    tree.omitted === 0 ? "" : `<p class="omitted">${String(tree.omitted)} files listed but not included</p>`,
    `<!--panels-->${panels.join("")}`,
  ].join("");
}

/**
 * Shows one file panel at a time. Real buttons, so the tree is reachable
 * by keyboard; no framework, because the page has to work from a file://
 * URL with nothing to fetch and nothing to install.
 */
const SCRIPT = `<script>
(function () {
  var open = null;
  function show(id) {
    if (open) { open.el.hidden = true; open.btn.setAttribute("aria-expanded", "false"); }
    if (open && open.id === id) { open = null; return; }
    var el = document.getElementById(id);
    var btn = document.querySelector('[data-file="' + id + '"]');
    if (!el || !btn) return;
    el.hidden = false;
    btn.setAttribute("aria-expanded", "true");
    open = { id: id, el: el, btn: btn };
    el.scrollIntoView({ block: "nearest" });
  }
  document.querySelectorAll("[data-file]").forEach(function (btn) {
    btn.setAttribute("aria-expanded", "false");
    btn.addEventListener("click", function () { show(btn.getAttribute("data-file")); });
  });
})();
</script>`;

/**
 * Totals across the record. Static: every figure here is already written
 * down, so it needs no server and no live connection.
 *
 * Silent when nothing has been measured. Runs recorded before usage was
 * captured carry none, and a strip reading "$0.00" over half a history
 * would be worse than no strip.
 */
function summaryStrip(views: readonly RunView[]): string {
  const measured = views.filter((view) => view.run.usage !== undefined);
  if (measured.length === 0) return "";
  const sum = (pick: (usage: NonNullable<RunRecord["usage"]>) => number): number =>
    measured.reduce((total, view) => total + pick(view.run.usage!), 0);

  const tokens = sum((u) => u.totalTokens);
  const input = sum((u) => u.input);
  const cacheRead = sum((u) => u.cacheRead);
  const cached = input + cacheRead === 0 ? 0 : Math.round((cacheRead / (input + cacheRead)) * 100);
  const models = [...new Set(measured.map((view) => view.run.usage?.model).filter((m): m is string => m !== undefined))];

  const cell = (key: string, value: string, extra = ""): string =>
    `<div class="cell"><span class="k">${escape(key)}</span>`
    + `<span class="v">${escape(value)}${extra === "" ? "" : `<small>${escape(extra)}</small>`}</span></div>`;

  return [
    '<div class="strip">',
    cell("Model", models.length === 1 ? models[0] ?? "" : `${String(models.length)} models`),
    cell("Turns", sum((u) => u.turns).toLocaleString("en-GB")),
    cell("Tokens", tokens.toLocaleString("en-GB"), cached > 0 ? ` ${String(cached)}% cached` : ""),
    cell("Output", sum((u) => u.output).toLocaleString("en-GB")),
    cell("Cost", `$${sum((u) => u.costUsd).toFixed(2)}`),
    measured.length === views.length
      ? ""
      : `<p class="partial">${String(views.length - measured.length)} earlier runs were recorded before usage was captured, and are not counted here.</p>`,
    "</div>",
  ].join("");
}

export function renderPage(
  project: string,
  views: readonly RunView[],
  tree: ProjectTree = { files: [], omitted: 0 },
): string {
  const applied = views.filter((v) => v.run.outcome === "applied" && v.standing).length;
  const browser = fileBrowser(tree);
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escape(project)} - harness record</title>`,
    `<style>${STYLE}</style></head><body><main>`,
    `<h1>${escape(project)}</h1>`,
    `<p class="sub">${String(views.length)} runs recorded &middot; ${String(applied)} still standing &middot; read-only</p>`,
    summaryStrip(views),
    browser === "" ? "" : `<div class="shell"><aside>${browser.split("<!--panels-->")[0] ?? ""}</aside><div class="col">`,
    browser === "" ? "" : (browser.split("<!--panels-->")[1] ?? ""),
    ...views.map(runSection),
    browser === "" ? "" : "</div></div>",
    "</main>",
    browser === "" ? "" : SCRIPT,
    "</body></html>",
    "",
  ].join("\n");
}
