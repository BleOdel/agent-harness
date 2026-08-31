/**
 * Who is at the desk, in pixels.
 *
 * Two agents work on a change and they are not interchangeable: the
 * builder writes it, the reviewer judges it, and they never share a
 * session. The page said so in words. A figure says it at a glance, and
 * it encodes something true rather than decorating -- most usefully that
 * during `gating` **nobody** is at the desk, because the gates are
 * ordinary code and no model is running at all.
 *
 * Drawn as a character grid rather than paths: a scene is legible in the
 * source, and a pixel is one rect with `shape-rendering: crispEdges`, so
 * it stays sharp at any size instead of turning into a soft vector blob.
 */

export type Figure = "building" | "gating" | "reviewing" | "applying" | "idle";

/** One character per pixel. Space is transparent. */
const PALETTE: Record<string, string> = {
  d: "desk",
  c: "case",
  s: "screen",
  l: "line",
  k: "skin",
  h: "hair",
  b: "body",
  a: "arm",
  g: "glasses",
  t: "tick",
  p: "spin",
  r: "chair",
};

const UNIT = 4;

/** Turns a grid into rects, one run of identical pixels at a time. */
function draw(rows: readonly string[], group?: string): string {
  const out: string[] = [];
  for (const [y, row] of rows.entries()) {
    let x = 0;
    while (x < row.length) {
      const key = row[x]!;
      if (key === " " || !(key in PALETTE)) {
        x += 1;
        continue;
      }
      let width = 1;
      while (row[x + width] === key) width += 1;
      out.push(
        `<rect x="${String(x * UNIT)}" y="${String(y * UNIT)}"`
        + ` width="${String(width * UNIT)}" height="${String(UNIT)}" class="${PALETTE[key] ?? ""}"/>`,
      );
      x += width;
    }
  }
  return group === undefined ? out.join("") : `<g class="${group}">${out.join("")}</g>`;
}

// Shared furniture. The desk sits at row 15 so every scene lines up.
const DESK = draw([
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  " dddddddddddddddddddddd ",
  "  d                d    ",
  "  d                d    ",
  "  d                d    ",
  "  d                d    ",
]);

/** Five content rows, so lines can alternate with gaps and read as text. */
const MONITOR = (screen: readonly string[]): string => draw([
  "                        ",
  "                        ",
  "                        ",
  "             cccccccccc ",
  "             cssssssssc ",
  ...screen,
  "             cssssssssc ",
  "             cccccccccc ",
  "                 cc     ",
  "                 cc     ",
  "              cccccccc  ",
]);

const TYPING = [
  "             cslllllllc ",
  "             cssssssssc ",
  "             cslllllssc ",
  "             cssssssssc ",
  "             csllllllsc ",
];
const DOCUMENT = [
  "             cslllllllc ",
  "             cssssssssc ",
  "             cslllllllc ",
  "             cssssssssc ",
  "             cslllllssc ",
];
const SPINNING = [
  "             cssssssssc ",
  "             cssspppssc ",
  "             cssp   psc ",
  "             cssspppssc ",
  "             cssssssssc ",
];
const TICK = [
  "             cssssssssc ",
  "             cssssssttc ",
  "             cstsssttsc ",
  "             csststtssc ",
  "             csssttsssc ",
];
const BLANK = [
  "             cssssssssc ",
  "             cssssssssc ",
  "             cssssssssc ",
  "             cssssssssc ",
  "             cssssssssc ",
];

/** Head and shoulders. The two agents differ above the neck and in colour. */
const BUILDER = draw([
  "                        ",
  "                        ",
  "                        ",
  "    hhhh                ",
  "   hkkkkh               ",
  "   hkkkkh               ",
  "    kkkk                ",
  "     kk                 ",
  "   bbbbbb               ",
  "  bbbbbbbb              ",
  "  bbbbbbbb              ",
  "  bbbbbbbb              ",
  "  bbbbbbbb              ",
  "  bbbbbbbb              ",
  "  bbbbbbbb              ",
]);

const REVIEWER = draw([
  "                        ",
  "                        ",
  "                        ",
  "   hhhhhh               ",
  "  hhhhhhhh              ",
  "  hkkkkkkh              ",
  "  hggkkggh              ",
  "   kkkkkk               ",
  "     kk                 ",
  "   bbbbbb               ",
  "  bbbbbbbb              ",
  "  bbbbbbbb              ",
  "  bbbbbbbb              ",
  "  bbbbbbbb              ",
  "  bbbbbbbb              ",
]);

/** Arms reach for the keyboard; the group is what moves. */
const ARMS = draw([
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  "          aaaa          ",
  "           aaaa         ",
], "arms");

const ARM_STILL = draw([
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  "          aaa           ",
]);

const CHAIR = draw([
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  "                        ",
  "   rr                   ",
  "   rr                   ",
  "   rr                   ",
  "   rr                   ",
  "  rrrrrr                ",
  "                        ",
]);

const FIGURES: Record<Figure, string> = {
  building: DESK + MONITOR(TYPING) + BUILDER + ARMS,
  // Nobody. The gates are ordinary code -- no model is running, and a
  // figure here would say something false.
  gating: DESK + MONITOR(SPINNING) + CHAIR,
  reviewing: DESK + MONITOR(DOCUMENT) + REVIEWER + ARM_STILL,
  applying: DESK + MONITOR(TICK) + BUILDER + ARM_STILL,
  idle: DESK + MONITOR(BLANK) + CHAIR,
};

export const figureSvg = (phase: Figure): string =>
  `<svg class="fig ${phase}" viewBox="0 0 96 80" width="72" height="60" aria-hidden="true">`
  + `${FIGURES[phase]}</svg>`;

/** Said in words too. The picture is a glance; this is the answer. */
export const figureLabel = (phase: Figure): string => ({
  building: "the builder is writing",
  gating: "the gates are running — no model involved",
  reviewing: "the reviewer is reading the diff",
  applying: "applying, with a snapshot taken first",
  idle: "nothing is running",
}[phase]);

export const FIGURE_STYLE = `
.fig{flex:none;shape-rendering:crispEdges}
.fig .desk{fill:var(--dim);opacity:.45}
.fig .case{fill:var(--dim);opacity:.7}
.fig .screen{fill:var(--card)}
.fig .line{fill:var(--accent)}
.fig .body{fill:var(--accent)}
.fig .arm{fill:var(--accent)}
.fig .skin{fill:var(--dim)}
.fig .hair{fill:var(--fg);opacity:.85}
.fig .glasses{fill:var(--fg)}
.fig .chair{fill:var(--dim);opacity:.35}
.fig .tick{fill:var(--add)}
.fig .spin{fill:var(--accent);animation:blink .9s steps(1) infinite}
.fig.reviewing .body,.fig.reviewing .arm,.fig.reviewing .line{fill:var(--rev)}
.fig .arms{animation:tap .42s steps(1) infinite alternate}
@keyframes tap{from{transform:translateY(0)}to{transform:translateY(4px)}}
@keyframes blink{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.fig *{animation:none !important}}
`;
