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
 * Drawn as character grids, one character per pixel, several frames per
 * scene. Frames are stacked and shown one at a time by `steps()`, which
 * is how pixel art has always moved: discrete poses, not a tweened
 * transform. A transform slides; a sprite acts.
 */

export type Figure = "building" | "gating" | "reviewing" | "applying" | "idle";

/** One character per pixel. Space is transparent. */
const PALETTE: Record<string, string> = {
  D: "desk", E: "desk-dark",
  C: "case", S: "screen", L: "line", M: "line-dim",
  k: "skin", n: "skin-dark", e: "eye",
  h: "hair", H: "hair-light",
  b: "shirt", B: "shirt-dark", w: "cuff",
  g: "glasses", t: "tick", p: "spin", r: "chair",
  m: "mug", u: "steam",
};

/** Exported so a test can check alignment without restating the number. */
export const UNIT = 3;

function draw(rows: readonly string[]): string {
  const out: string[] = [];
  for (const [y, row] of rows.entries()) {
    let x = 0;
    while (x < row.length) {
      const key = row[x]!;
      if (!(key in PALETTE)) { x += 1; continue; }
      let width = 1;
      while (row[x + width] === key) width += 1;
      out.push(
        `<rect x="${String(x * UNIT)}" y="${String(y * UNIT)}"`
        + ` width="${String(width * UNIT)}" height="${String(UNIT)}" class="${PALETTE[key] ?? ""}"/>`,
      );
      x += width;
    }
  }
  return out.join("");
}

/** Overlays one grid on another; later rows win where they are not blank. */
function layer(...grids: readonly string[][]): string[] {
  const height = Math.max(...grids.map((g) => g.length));
  const width = Math.max(...grids.flatMap((g) => g.map((r) => r.length)));
  const merged: string[] = [];
  for (let y = 0; y < height; y += 1) {
    let row = "";
    for (let x = 0; x < width; x += 1) {
      let pixel = " ";
      for (const grid of grids) {
        const candidate = grid[y]?.[x] ?? " ";
        if (candidate !== " ") pixel = candidate;
      }
      row += pixel;
    }
    merged.push(row);
  }
  return merged;
}

const blank = (): string[] => Array.from({ length: 26 }, () => " ".repeat(34));

const DESK: string[] = [
  ...Array.from({ length: 20 }, () => " ".repeat(34)),
  " DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD ",
  " EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE ",
  "   DD                      DD     ",
  "   DD                      DD     ",
  "   DD                      DD     ",
  "   DD                      DD     ",
];

/** The monitor, with five rows of screen for whatever it is showing. */
const monitor = (screen: readonly string[]): string[] => layer(blank(), [
  "                                  ",
  "                                  ",
  "                                  ",
  "                CCCCCCCCCCCCCCCC  ",
  "                CSSSSSSSSSSSSSSC  ",
  "                CSSSSSSSSSSSSSSC  ",
  ...screen.map((row) => `                C${row}C  `),
  "                CSSSSSSSSSSSSSSC  ",
  "                CCCCCCCCCCCCCCCC  ",
  "                      CCCC        ",
  "                      CCCC        ",
  "                    CCCCCCCC      ",
]);

const CODE = ["LLLLLLLLLSSSSS", "SSSSSSSSSSSSSS", "SSLLLLLLLLLLSS", "SSSSSSSSSSSSSS", "SSLLLLLLSSSSSS"];
const CODE2 = ["LLLLLLLLLLLSSS", "SSSSSSSSSSSSSS", "SSLLLLLLLLSSSS", "SSSSSSSSSSSSSS", "SSLLLLLLLLLLSS"];
const DOC = ["MMMMMMMMMMMMSS", "SSSSSSSSSSSSSS", "MMMMMMMMMMSSSS", "SSSSSSSSSSSSSS", "MMMMMMMSSSSSSS"];
const SPIN_A = ["SSSSSSSSSSSSSS", "SSSSSpppSSSSSS", "SSSSpSSSpSSSSS", "SSSSSpppSSSSSS", "SSSSSSSSSSSSSS"];
const SPIN_B = ["SSSSSSSSSSSSSS", "SSSSpSSSpSSSSS", "SSSSSSSSSSSSSS", "SSSSpSSSpSSSSS", "SSSSSSSSSSSSSS"];
const TICK = ["SSSSSSSSSSSSSS", "SSSSSSSSSSttSS", "SStSSSSSttSSSS", "SSSttSttSSSSSS", "SSSStttSSSSSSS"];
const OFF = Array.from({ length: 5 }, () => "SSSSSSSSSSSSSS");

/**
 * A seated person from the waist up. `arms` is the only thing that moves,
 * so every pose shares one body and differs by a few pixels.
 */
const person = (hair: readonly string[], face: readonly string[], arms: readonly string[]): string[] =>
  layer(blank(), [...hair], [...face], [
    "                                  ",
    "                                  ",
    "                                  ",
    "                                  ",
    "                                  ",
    "                                  ",
    "                                  ",
    "                                  ",
    "                                  ",
    "                                  ",
    "        kkkk                      ",
    "      BBbbbbBB                    ",
    "     BbbbbbbbbB                   ",
    "     bbbbbbbbbb                   ",
    "     bbbbbbbbbb                   ",
    "     bbbbbbbbbb                   ",
    "     bbbbbbbbbb                   ",
    "     BbbbbbbbbB                   ",
    "     BBBBBBBBBB                   ",
  ], [...arms]);

const BUILDER_HAIR = [
  "                                  ",
  "                                  ",
  "                                  ",
  "        hhhhhh                    ",
  "       hHHhhhhh                   ",
  "      hhHhhhhhhh                  ",
  "      hh      hh                  ",
];
const BUILDER_FACE = [
  "                                  ",
  "                                  ",
  "                                  ",
  "                                  ",
  "                                  ",
  "        kkkkkk                    ",
  "       kkkkkkkk                   ",
  "       keekeekk                   ",
  "       kkkkkkkn                   ",
  "        nkkkkn                    ",
];

const REVIEWER_HAIR = [
  "                                  ",
  "                                  ",
  "                                  ",
  "        hhhhhh                    ",
  "      hhHHhhhhhh                  ",
  "     hhhHhhhhhhhh                 ",
  "     hhh      hhh                 ",
  "     hh        hh                 ",
  "      h        h                  ",
];
const REVIEWER_FACE = [
  "                                  ",
  "                                  ",
  "                                  ",
  "                                  ",
  "                                  ",
  "        kkkkkk                    ",
  "       kkkkkkkk                   ",
  "       geekeeg                    ",
  "       kkkkkkkn                   ",
  "        nkkkkn                    ",
];

/** Typing: the two hands alternate, one row apart. */
const TYPE_A = [
  ...Array.from({ length: 15 }, () => " ".repeat(34)),
  "               wwww               ",
  "                  wwww            ",
];
const TYPE_B = [
  ...Array.from({ length: 15 }, () => " ".repeat(34)),
  "                  wwww            ",
  "               wwww               ",
];
/** A stretch: both arms up, once every few seconds. */
const STRETCH_ARMS = [
  ...Array.from({ length: 9 }, () => " ".repeat(34)),
  "    ww        ww                  ",
  "    ww        ww                  ",
  "     w        w                   ",
];
const REACH = [
  ...Array.from({ length: 15 }, () => " ".repeat(34)),
  "               wwwwww             ",
];
const REACH_MUG = [
  ...Array.from({ length: 13 }, () => " ".repeat(34)),
  "              u                   ",
  "             mmm                  ",
  "             mmm                  ",
  "            wwww                  ",
];

const CHAIR: string[] = layer(blank(), [
  ...Array.from({ length: 11 }, () => " ".repeat(34)),
  "     rrrr                         ",
  "     rrrr                         ",
  "     rrrr                         ",
  "     rrrr                         ",
  "     rrrr                         ",
  "   rrrrrrrr                       ",
]);

/** Each scene is a list of frames, shown one at a time. */
const SCENES: Record<Figure, string[][]> = {
  building: [
    layer(DESK, monitor(CODE), person(BUILDER_HAIR, BUILDER_FACE, TYPE_A)),
    layer(DESK, monitor(CODE2), person(BUILDER_HAIR, BUILDER_FACE, TYPE_B)),
    layer(DESK, monitor(CODE), person(BUILDER_HAIR, BUILDER_FACE, TYPE_B)),
    layer(DESK, monitor(CODE2), person(BUILDER_HAIR, BUILDER_FACE, TYPE_A)),
    // The gesture: a stretch, then straight back to work.
    layer(DESK, monitor(CODE2), person(BUILDER_HAIR, BUILDER_FACE, STRETCH_ARMS)),
    layer(DESK, monitor(CODE), person(BUILDER_HAIR, BUILDER_FACE, TYPE_A)),
  ],
  // Nobody. The gates are ordinary code -- no model is running, and a
  // figure here would say something false.
  gating: [layer(DESK, monitor(SPIN_A), CHAIR), layer(DESK, monitor(SPIN_B), CHAIR)],
  reviewing: [
    layer(DESK, monitor(DOC), person(REVIEWER_HAIR, REVIEWER_FACE, REACH)),
    layer(DESK, monitor(DOC), person(REVIEWER_HAIR, REVIEWER_FACE, REACH_MUG)),
  ],
  applying: [layer(DESK, monitor(TICK), person(BUILDER_HAIR, BUILDER_FACE, REACH))],
  idle: [layer(DESK, monitor(OFF), CHAIR)],
};

export function figureSvg(phase: Figure): string {
  const frames = SCENES[phase];
  const cells = frames
    .map((frame, index) => `<g class="fr fr${String(index)}">${draw(frame)}</g>`)
    .join("");
  return `<svg class="fig ${phase} n${String(frames.length)}" viewBox="0 0 102 78"`
    + ` width="102" height="78" aria-hidden="true">${cells}</svg>`;
}

/** Said in words too. The picture is a glance; this is the answer. */
export const figureLabel = (phase: Figure): string => ({
  building: "the builder is writing",
  gating: "the gates are running — no model involved",
  reviewing: "the reviewer is reading the diff",
  applying: "applying, with a snapshot taken first",
  idle: "nothing is running",
}[phase]);

/** One frame visible at a time, held rather than blended. */
function frameRules(count: number, seconds: number): string {
  if (count < 2) return "";
  const slice = 100 / count;
  const rules: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const from = (index * slice).toFixed(4);
    const to = ((index + 1) * slice).toFixed(4);
    rules.push(
      `@keyframes f${String(count)}-${String(index)}{`
      + `0%,${from}%{opacity:0}${from}%,${to}%{opacity:1}${to}%,100%{opacity:0}}`,
    );
    rules.push(
      `.fig.n${String(count)} .fr${String(index)}`
      + `{animation:f${String(count)}-${String(index)} ${String(seconds)}s steps(1) infinite}`,
    );
  }
  return rules.join("\n");
}

export const FIGURE_STYLE = `
.fig{flex:none;shape-rendering:crispEdges}
.fig .fr{opacity:0}
.fig .fr0{opacity:1}
.fig .desk{fill:var(--dim);opacity:.55}
.fig .desk-dark{fill:var(--dim);opacity:.8}
.fig .case{fill:var(--dim);opacity:.75}
.fig .screen{fill:var(--card)}
.fig .line{fill:var(--accent)}
.fig .line-dim{fill:var(--rev)}
.fig .skin{fill:#e8b48c}
.fig .skin-dark{fill:#c9906a}
.fig .eye{fill:#2b2118}
.fig .hair{fill:#4a3122}
.fig .hair-light{fill:#6b4830}
.fig .shirt{fill:var(--accent)}
.fig .shirt-dark{fill:var(--accent);opacity:.72}
.fig .cuff{fill:#e8b48c}
.fig .glasses{fill:#2b2118}
.fig .chair{fill:var(--dim);opacity:.4}
.fig .tick{fill:var(--add)}
.fig .spin{fill:var(--accent)}
.fig .mug{fill:var(--rev)}
.fig .steam{fill:var(--dim);opacity:.5}
.fig.reviewing .shirt{fill:var(--rev)}
.fig.reviewing .shirt-dark{fill:var(--rev);opacity:.72}
.fig.reviewing .hair{fill:#7a5a2a}
.fig.reviewing .hair-light{fill:#a37c3d}
${frameRules(6, 2.4)}
${frameRules(2, 1)}
@media (prefers-reduced-motion:reduce){
  .fig .fr{animation:none !important;opacity:0}
  .fig .fr0{opacity:1}
}
`;
