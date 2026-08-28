/**
 * Counts assertions actually executed during a test run.
 *
 * Loaded through NODE_OPTIONS=--import, so it applies to every Node
 * process the test command spawns -- including through `npm test`, which
 * is one layer of indirection that would defeat a per-file approach.
 *
 * A real file rather than a program built inside a string literal. The
 * boundary probe took that shortcut and lost a verification round to an
 * escape sequence consumed at emit time; nothing here is worth repeating
 * that for.
 */

import fs from "node:fs";
import assert from "node:assert";
import strict from "node:assert/strict";

let executed = 0;
const seen = new Set();
const count = (fn) =>
  new Proxy(fn, {
    apply(target, self, args) {
      executed += 1;
      return Reflect.apply(target, self, args);
    },
  });

// node:assert/strict and assert.strict are the same object. Without the
// identity check a two-assertion suite reports four -- a gate claiming
// more verification than happened. Verified by removing it.
//
// There is deliberately no second dedupe on the functions themselves. One
// was written here and removing it changed no count, because distinct
// module objects hold distinct property slots even when the underlying
// function is shared. A guard that cannot be made to fail is not
// protection, it is furniture.
for (const module of [assert, strict, assert.strict]) {
  if (!module || seen.has(module)) continue;
  seen.add(module);
  for (const key of Object.keys(module)) {
    const value = module[key];
    if (typeof value !== "function") continue;
    try {
      module[key] = count(value);
    } catch {
      // A non-writable export stays uncounted rather than aborting the
      // run. The gate reports the count it has; it never claims more.
    }
  }
}

process.on("exit", () => {
  const target = process.env.HARNESS_ASSERT_COUNT_FILE;
  if (!target) return;
  try {
    fs.appendFileSync(target, `${executed}\n`);
  } catch {
    // Nothing to do from inside an exit handler. A missing count reads as
    // zero, which fails the gate closed.
  }
});
