import {nextAction,workspacePanels,GUIDANCE_STYLE} from './guidance.ts';
import {emptyWorkspace,type WorkspaceInfo} from './workspace.ts';
import {WORKSPACE_SCRIPT} from './workspace-client.ts';
import { officeModel, officeSection, OFFICE_STYLE, OFFICE_SCRIPT, type OfficeModel } from "./office.ts";
import { type TeamView } from "./status.ts";
import { overview, taskList, teamCards, DASHBOARD_STYLE, DASHBOARD_SCRIPT } from "./dashboard.ts";
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
import type { Feature } from "../features.ts";
import { FIGURE_STYLE, figureLabel, figureSvg, type Figure } from "./figures.ts";
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

/**
 * A timestamp in the reader's own clock.
 *
 * The record stores UTC, which is right for a record and wrong to show:
 * on a machine an hour ahead, every run appeared to have happened an hour
 * before it did, and the build marker -- whose whole job is being compared
 * against "now" -- was off by the same hour. Nothing said so, because a
 * time that is merely wrong still looks like a time.
 */
export function localTime(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${String(when.getFullYear())}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`
    + ` ${pad(when.getHours())}:${pad(when.getMinutes())}`;
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
  blocked: "blocked — input needed",
  "environment-blocked": "blocked — verification environment unavailable",
};

export function diffBlock(file: FileDiff): string {
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
    `<details data-state-key="diff-${escape(file.file)}"><summary><span class="path">${escape(file.file)}</span>`,
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
    `<section class="run ${escape(run.outcome)}${reversed ? " reversed" : ""}" id="${escape(run.id)}" data-run data-group="${reversed ? "reversed" : run.outcome === "applied" ? "applied" : run.outcome === "no-changes" ? "no-changes" : "attention"}" data-search="${escape([run.id, view.title ?? run.goal, run.goal, run.outcome, run.reason ?? "", ...view.files.map(f => f.file)].join(" ").toLowerCase())}">`,
    `<header><h2>${escape(run.id)}<span class="goal">${escape(view.title ?? run.goal)}</span></h2>`,
    `<p class="meta">${escape(localTime(run.at))}`,
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
    view.criteria.length === 0 ? "" : `<div class="criteria"><h3>Acceptance criteria</h3><ul>${view.criteria.map((c) => `<li>${escape(c)}</li>`).join("")}</ul></div>`,
    run.gates.length === 0 ? "" : `<ul class="gates">${run.gates.map((g) => `<li>${escape(g)}</li>`).join("")}</ul>`,
    findings.length === 0 ? "" : `<div class="findings"><h3>The reviewer said</h3><ul>${findings.map((f) => `<li>${escape(f)}</li>`).join("")}</ul></div>`,
    run.reason === undefined ? "" : `<p class="reason">${escape(run.reason)}</p>`,
    run.requestedInput === undefined ? "" : `<p class="reason">Needed: ${escape(run.requestedInput)}</p>`,
    view.files.length === 0 ? "" : `<div class="files">${view.files.map(diffBlock).join("")}</div>`,
    `</section>`,
  ].join("");
}

const STYLE = `
:root{--bg:#fbfaf7;--fg:#14171a;--dim:#5f6b72;--line:#e2ded4;--add:#0a7f42;--del:#b3261e;--accent:#1a49c4;--rev:#8a4b00;--card:#fff}
@media(prefers-color-scheme:dark){:root{--bg:#101315;--fg:#eef1f2;--dim:#93a1a8;--line:#283135;--add:#4ade80;--del:#f87171;--accent:#7aa2ff;--rev:#e0a458;--card:#161b1e}}
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
.built{color:var(--dim);font-size:.72rem;margin:2.5rem 0 0;text-align:right}

.live{display:flex;gap:1rem;align-items:center;background:var(--card);border:1px solid var(--line);
  border-left:4px solid var(--accent);border-radius:10px;padding:.6rem 1.25rem;margin:0 0 1.25rem}
.live.reviewing{border-left-color:var(--rev)}
.live.gating,.live.stopped{border-left-color:var(--line)}
.live-text{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dim);min-width:0}
.live-text b{display:block;font-size:14px;color:var(--fg);font-weight:600}
${FIGURE_STYLE}
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
.side-h{font-size:.68rem;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);margin:0 0 .5rem;display:flex;gap:.5rem;align-items:baseline}
.side-h + .side-h{margin-top:1.75rem}
.queue + .side-h{margin-top:1.75rem}
.qleft{margin-left:auto;text-transform:none;letter-spacing:0;font-size:.72rem}
.queue{list-style:none;margin:0;padding:0;font-size:.83rem}
.queue li{display:flex;flex-wrap:wrap;gap:.5rem;align-items:baseline;padding:.15rem .25rem;border-radius:3px}
.queue li.is-next{background:var(--line)}
.qid{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qpri{color:var(--dim);font-size:.68rem;text-transform:uppercase;letter-spacing:.05em}
.dot{width:6px;height:6px;border-radius:50%;flex:none;transform:translateY(-1px);background:var(--line)}
.dot.done{background:var(--add)}
.dot.next{background:var(--accent)}
.qstate{flex-basis:100%;color:var(--dim);font-size:.72rem;overflow-wrap:anywhere}
.dot.needs-revalidation{background:var(--rev)}
.dot.blocked{background:var(--del)}
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

export interface QueueItem {
  readonly feature: Feature;
  /** What the last run for this item did, when there was one. */
  readonly state: string;
  readonly next: boolean;
  readonly waitingFor?: readonly string[];
}

/**
 * The backlog, in the order `work` will take it.
 *
 * `look` has always shown this in the terminal; the page had the data
 * loaded and did not use it. Which item is next is the one thing here a
 * reader cannot work out for themselves -- MoSCoW order, minus what is
 * done, minus anything whose last run changed nothing.
 */
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
      `<li data-file-entry data-search="${escape(file.path.toLowerCase())}"><button type="button" aria-controls="f${String(index)}" data-file="f${String(index)}">`
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
    return `<article class="panel" id="f${String(index)}" data-file-path="${escape(file.path)}" hidden>`
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
  var bound=new WeakSet();
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
  window.bindHarnessFiles=function(){
  open=null;
  document.querySelectorAll("[data-file]").forEach(function (btn) {
    if(bound.has(btn))return;bound.add(btn);
    btn.setAttribute("aria-expanded", "false");
    btn.addEventListener("click", function () { show(btn.getAttribute("data-file")); });
  });
  };window.bindHarnessFiles();
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
    cell("Reported cost", `$${sum((u) => u.costUsd).toFixed(2)}`),
    measured.length === views.length
      ? ""
      : `<p class="partial">${String(views.length - measured.length)} earlier runs were recorded before usage was captured, and are not counted here.</p>`,
    "</div>",
  ].join("");
}

/**
 * Polls `/status` while a run is in flight. Only included when the page
 * is served -- a file:// page cannot fetch, so shipping this into a saved
 * file would give a permanently silent banner.
 */
const PHASES: Figure[] = ["building", "gating", "reviewing", "applying", "idle"];

/** All five ship with the page; the script swaps which one is shown. */
const FIGURE_MARKUP = PHASES
  .map((phase) => `<template id="fig-${phase}">${figureSvg(phase)}</template>`)
  .join("");

const FIGURE_LABELS = JSON.stringify(
  Object.fromEntries(PHASES.map((phase) => [phase, figureLabel(phase)])),
);

const LIVE_SCRIPT = `<script>
(function () {
  var connection = document.getElementById("connection-status");
  var box = document.getElementById("live");
  if (!box) return;
  var labels = ${FIGURE_LABELS};
  var figBox = document.getElementById("live-fig");
  var whoBox = document.getElementById("live-who");
  var detailBox = document.getElementById("live-detail");
  var showing = null;
  function figure(phase) {
    if (showing === phase) return;
    var tpl = document.getElementById("fig-" + phase);
    if (!tpl) return;
    figBox.replaceChildren(tpl.content.cloneNode(true));
    showing = phase;
  }
  function detail(d) {
    var secs = Math.round((Date.now() - Date.parse(d.startedAt)) / 1000);
    var mins = Math.floor(secs / 60);
    return " \u00b7 " + d.item
      + (d.attempt > 1 ? " (attempt " + d.attempt + ")" : "")
      + " \u00b7 " + d.turns + " turns"
      + (d.tokens ? " \u00b7 " + d.tokens.toLocaleString("en-GB") + " tokens" : "")
      + " \u00b7 " + (mins ? mins + "m " + (secs % 60) + "s" : secs + "s");
  }
  function paint(s) {
    if (window.updateHarnessOffice) window.updateHarnessOffice(s.officeHtml, true);
    connection.textContent = "Connected · status updated " + new Date().toLocaleTimeString();
    connection.dataset.state = "connected";
    var teams = document.getElementById("team-status");
    if (teams && typeof s.teamsHtml === "string" && teams.dataset.last !== s.teamsHtml && !teams.contains(document.activeElement)) {
      var expanded = Array.from(teams.querySelectorAll('details[open]')).map(function(d){return d.getAttribute('data-team-detail');});
      // HTML is produced only by the host renderer, which escapes every project value.
      teams.innerHTML = s.teamsHtml;
      teams.dataset.last = s.teamsHtml;
      teams.querySelectorAll('details').forEach(function(d){d.open=expanded.indexOf(d.getAttribute('data-team-detail'))!==-1;});
    }
    if (!s || !s.live) {
      box.hidden = !s || !s.reason;
      if (s && s.reason) {
        box.className = "live stopped";
        figure("idle");
        whoBox.textContent = "stopped";
        detailBox.textContent = " \u00b7 " + s.reason;
      }
      return;
    }
    var d = s.status;
    box.hidden = false;
    box.className = "live " + d.phase;
    figure(d.phase);
    whoBox.textContent = labels[d.phase] || d.phase;
    detailBox.textContent = detail(d);
  }
  var pending = false;
  function tick() {
    if (pending) return;
    pending = true;
    fetch("/status", { cache: "no-store", signal: AbortSignal.timeout(8000) })
      .then(function (r) { if (!r.ok) throw new Error("Status unavailable"); return r.json(); })
      .then(paint)
      .catch(function () { if (window.updateHarnessOffice) window.updateHarnessOffice(null, false); box.hidden = true; connection.textContent = "Connection lost · displayed details may be out of date. Retrying…"; connection.dataset.state = "lost"; })
      .finally(function () { pending = false; });
  }
  tick();
  setInterval(tick, 2000);
})();
</script>`;

export function renderPage(
  project: string,
  views: readonly RunView[],
  tree: ProjectTree = { files: [], omitted: 0 },
  live = false,
  items: readonly QueueItem[] = [],
  /**
   * When the harness that produced this page was last changed.
   *
   * `--serve` reads the code once, at startup, so every later fix is
   * invisible until it is restarted -- and a page that is merely out of
   * date looks exactly like a feature that does not work. It cost three
   * rounds of "I don't see it" before anyone thought to check the clock.
   */
  builtAt: string | undefined = undefined,
  teams: readonly TeamView[] = [],
  warnings: readonly string[] = [],
  projectPath: string = project,
  office: OfficeModel = officeModel(teams, undefined, live),
  workspace?:WorkspaceInfo,
  includeRoom=true,
): string {
  const extra=workspacePanels(items,teams,views,workspace??emptyWorkspace(),live,projectPath);
  const applied = views.filter((v) => v.run.outcome === "applied" && v.standing).length;
  const browser = fileBrowser(tree);
  const sidebar = browser.split("<!--panels-->")[0] ?? "";
  const panels = browser.split("<!--panels-->")[1] ?? "";
  const toolbar = (kind: string, label: string, options = ""): string =>
    `<div class="toolbar"><label>Search ${label}<input type="search" id="${kind}-search" placeholder="Search by name or ID"></label>${options ? `<label>Status<select id="${kind}-filter"><option value="all">All statuses</option>${options}</select></label>` : ""}</div><p id="${kind}-result" class="filter-result" role="status"></p>`;
  const empty = (kind: string): string => `<p id="${kind}-empty" class="empty" hidden>No matches. Try a different search or status.</p>`;
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escape(project)} · Harness</title>`,
    `<style>${STYLE}${DASHBOARD_STYLE}${OFFICE_STYLE}${GUIDANCE_STYLE}</style></head><body><a class="skip-link" href="#overview">Skip to project overview</a><main>`,
    '<div class="rail"><div class="brand"><span>▥</span> Harness</div><p>Project workspace</p><nav aria-label="Project sections"><a href="#overview">Next step</a><a href="#attention">Needs attention</a><a href="#office">Agent office</a><a href="#journey">Project journey</a><a href="#review">Review changes</a><a href="#outputs">Outputs</a><a href="#tasks">Tasks</a><a href="#history">Run history</a><a href="#teams">Teams</a><a href="#project-files">Files</a></nav><div class="rail-bottom"><p>Local · read-only</p><p>Plan and run work with<br><code>harness guide</code></p></div></div>',
    '<div class="workspace">',
    `<header class="page-head"><div><p class="eyebrow">Project overview</p><h1>${escape(project)}</h1><p class="team-id">${escape(projectPath)}</p></div><div class="page-actions"><span class="badge">${live ? "Live status" : "Saved snapshot"}</span>${live ? '<button class="action" id="refresh-overview" type="button">Refresh overview</button>' : ""}</div></header>`,
    `<p class="sub" id="record-summary">${String(views.length)} runs recorded &middot; ${String(applied)} still standing &middot; read-only</p>`,
    live ? '<p id="workspace-update" class="update-note" role="status"></p><p id="connection-status" class="connection" role="status">Connecting to local status…</p><div class="live" id="live" hidden><span id="live-fig"></span><span class="live-text"><b id="live-who"></b><span id="live-detail"></span></span></div>' : "",
    overview(items, warnings,workspace?nextAction(items,teams,views,workspace):undefined,projectPath),
    extra.attention,
    officeSection(office,includeRoom),
    extra.journey,
    extra.orbit,
    '<section id="tasks" class="section"><div class="section-heading"><h2>Tasks</h2><p>Accepted scope and what comes next</p></div>',
    toolbar('task','tasks','<option value="open">Open</option><option value="attention">Needs attention / waiting</option><option value="done">Done</option><option value="excluded">Excluded</option>'),
    `<div id="task-content">${taskList(items)}</div>`, empty('task'), '</section>',
    '<section id="history" class="section"><div class="section-heading"><h2>Run history</h2><p>Changes, checks and review findings</p></div>',
    `<div id="usage-content">${summaryStrip(views)}</div>`,
    toolbar('run','runs','<option value="applied">Applied</option><option value="attention">Needs attention</option><option value="reversed">Reversed</option><option value="no-changes">No changes</option>'),
    `<div id="history-content">${views.length ? views.map(runSection).join('') : '<p class="empty">No runs yet. Once work starts, its checks and changes will appear here.</p>'}</div>`,
    empty('run'), '</section>', extra.review, extra.outputs,
    `<section id="teams" class="section"><div class="section-heading"><h2>Teams</h2><p>${live ? "Status updates automatically" : "Recorded team activity"}</p></div><div id="team-status">${teamCards(teams)}</div></section>`,
    '<section id="project-files" class="section"><div class="section-heading"><h2>Files</h2><p>Current source and the runs that changed it</p></div>',
    toolbar('file','file paths'),
    '<div id="files-content">',
    browser ? `<div class="file-layout"><aside aria-label="Project files">${sidebar}${empty('file')}</aside><div>${panels}<p class="note">Select a file to read its contents. Run links open its change history.</p></div></div>` : `<p class="empty">No project files to display.</p>${empty('file')}`,
    '</div></section>',
    builtAt === undefined ? "" : `<p class="built">harness of ${escape(builtAt)}${live ? " &middot; serving live; restart to pick up a newer harness" : ""}</p>`,
    `<p class="snapshot">Overview captured ${escape(localTime(new Date().toISOString()))}. ${live ? 'Tasks, files and history refresh automatically while keeping your place.' : 'This saved page does not update. Regenerate with harness view, or use harness view --serve for live status.'}</p>`,
    '</div></main>',
    SCRIPT,
    DASHBOARD_SCRIPT, OFFICE_SCRIPT, WORKSPACE_SCRIPT,
    live ? FIGURE_MARKUP + LIVE_SCRIPT : "",
    "</body></html>", "",
  ].join("\n");
}
