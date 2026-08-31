/**
 * Who is at the desk.
 *
 * Two agents work on a change and they are not interchangeable: the
 * builder writes it, the reviewer judges it, and they never share a
 * session. The page said so in words. A figure says it at a glance, and
 * it encodes something true rather than decorating -- most usefully that
 * during `gating` **nobody** is at the desk, because the gates are
 * ordinary code and no model is running at all.
 *
 * Inline SVG with CSS keyframes: the page carries its own contents and
 * fetches nothing, so an image file is not an option and would not be
 * worth it if it were.
 */

export type Figure = "building" | "gating" | "reviewing" | "applying" | "idle";

const DESK = `
  <rect x="6" y="60" width="84" height="3" rx="1.5" class="desk"/>
  <rect x="14" y="63" width="3" height="14" class="desk"/>
  <rect x="79" y="63" width="3" height="14" class="desk"/>`;

const MONITOR = (screen: string): string => `
  <rect x="52" y="28" width="34" height="24" rx="2.5" class="case"/>
  <rect x="55" y="31" width="28" height="18" rx="1.5" class="screen"/>
  ${screen}
  <rect x="66" y="52" width="6" height="6" class="case"/>
  <rect x="60" y="57" width="18" height="3" rx="1.5" class="case"/>`;

/** A seated figure. `arms` differs per activity; everything else is shared. */
const PERSON = (cls: string, arms: string, head: string): string => `
  <g class="${cls}">
    ${head}
    <path d="M18 60 q0-16 12-16 t12 16 z" class="body"/>
    ${arms}
  </g>`;

const BUILDER_HEAD = `
  <circle cx="30" cy="33" r="8" class="skin"/>
  <path d="M22 31 q2-9 8-9 t8 9 q-4-4-8-4 t-8 4z" class="hair"/>`;

const REVIEWER_HEAD = `
  <circle cx="30" cy="33" r="8" class="skin"/>
  <path d="M21 34 q0-12 9-12 t9 12 q0-6-9-6 t-9 6z" class="hair"/>
  <rect x="24" y="31" width="12" height="5" rx="2.5" class="glasses"/>`;

const FIGURES: Record<Figure, string> = {
  // Typing: both hands at the keyboard, alternating.
  building: `${DESK}
    ${MONITOR('<rect x="58" y="34" width="16" height="2" class="line a"/>'
      + '<rect x="58" y="38" width="20" height="2" class="line b"/>'
      + '<rect x="58" y="42" width="11" height="2" class="line c"/>')}
    ${PERSON("who builder", '<path d="M38 50 L58 57" class="arm left"/><path d="M40 52 L58 59" class="arm right"/>', BUILDER_HEAD)}`,

  // Nobody. The gates are ordinary code -- no model is running, and a
  // figure here would say something false.
  gating: `${DESK}
    ${MONITOR('<circle cx="69" cy="40" r="6" class="spinner"/>')}
    <path d="M18 60 q0-14 12-14 q6 0 9 5" class="chair"/>`,

  // Reading, not typing: leaning in, one hand still.
  reviewing: `${DESK}
    ${MONITOR('<rect x="58" y="34" width="20" height="2" class="line"/>'
      + '<rect x="58" y="38" width="20" height="2" class="line"/>'
      + '<rect x="58" y="42" width="13" height="2" class="line"/>'
      + '<circle cx="72" cy="40" r="7" class="lens"/>')}
    ${PERSON("who reviewer", '<path d="M39 50 L57 55" class="arm still"/>', REVIEWER_HEAD)}`,

  applying: `${DESK}
    ${MONITOR('<path d="M62 40 l5 5 l10 -11" class="tick"/>')}
    ${PERSON("who builder", '<path d="M38 50 L58 57" class="arm still"/>', BUILDER_HEAD)}`,

  idle: `${DESK}${MONITOR("")}<path d="M18 60 q0-14 12-14 q6 0 9 5" class="chair"/>`,
};

export const figureSvg = (phase: Figure): string =>
  `<svg class="fig ${phase}" viewBox="0 0 96 80" width="72" height="60" aria-hidden="true">${FIGURES[phase]}</svg>`;

/** Said in words too. The picture is a glance; this is the answer. */
export const figureLabel = (phase: Figure): string => ({
  building: "the builder is writing",
  gating: "the gates are running — no model involved",
  reviewing: "the reviewer is reading the diff",
  applying: "applying, with a snapshot taken first",
  idle: "nothing is running",
}[phase]);

export const FIGURE_STYLE = `
.fig{flex:none}
.fig .desk{fill:var(--dim);opacity:.35}
.fig .case{fill:var(--dim);opacity:.55}
.fig .screen{fill:var(--card)}
.fig .line{fill:var(--accent);opacity:.75}
.fig .body{fill:var(--accent)}
.fig .skin{fill:var(--dim);opacity:.85}
.fig .hair{fill:var(--fg);opacity:.8}
.fig .glasses{fill:none;stroke:var(--fg);stroke-width:1.2;opacity:.9}
.fig .arm{stroke:var(--accent);stroke-width:3.5;stroke-linecap:round;fill:none}
.fig .chair{fill:none;stroke:var(--dim);stroke-width:3;opacity:.4}
.fig .lens{fill:none;stroke:var(--fg);stroke-width:1.5;opacity:.85}
.fig .tick{fill:none;stroke:var(--add);stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
.fig .spinner{fill:none;stroke:var(--accent);stroke-width:2.5;stroke-dasharray:9 26;transform-origin:69px 40px;animation:spin 1.1s linear infinite}
.fig.reviewing .body{fill:var(--rev)}
.fig.reviewing .arm{stroke:var(--rev)}
.fig.reviewing .line{fill:var(--rev)}
.fig .arm.left{animation:tapA .5s ease-in-out infinite alternate}
.fig .arm.right{animation:tapB .5s ease-in-out infinite alternate}
.fig.reviewing .lens{animation:scan 2.6s ease-in-out infinite alternate}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes tapA{from{transform:translateY(0)}to{transform:translateY(1.5px)}}
@keyframes tapB{from{transform:translateY(1.5px)}to{transform:translateY(0)}}
@keyframes scan{from{transform:translateX(-9px)}to{transform:translateX(2px)}}
@media (prefers-reduced-motion:reduce){
  .fig *{animation:none !important}
}
`;
