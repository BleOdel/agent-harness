/**
 * Counts assertions actually executed during a test run.
 *
 * Loaded through NODE_OPTIONS=--import, so it applies to every Node
 * process the test command spawns -- including through `npm test`, which
 * is one layer of indirection that would defeat a per-file approach.
 *
 * Two mechanisms, because neither is sufficient alone:
 *
 * 1. A resolve hook that redirects `node:assert` to a shim whose every
 *    export is wrapped. This is what catches named and namespace imports,
 *    which bind at link time and are untouchable afterwards.
 * 2. Patching the module objects, which catches `require("node:assert")`
 *    and the test runner's own `t.assert.*`, since those reach the real
 *    module rather than an import binding.
 *
 * Both increment one counter on globalThis, so a call counted by one is
 * never counted again by the other.
 */

import fs from "node:fs";
import { registerHooks } from "node:module";
import assert from "node:assert";
import strict from "node:assert/strict";

globalThis.__harnessAssertions ??= 0;

const SHIM = new URL("./assert-shim.mjs", import.meta.url).href;
const REDIRECTED = new Set(["node:assert", "assert", "node:assert/strict", "assert/strict"]);

registerHooks({
  resolve(specifier, context, next) {
    // The shim's own require of the real module must pass through, or it
    // resolves to itself and the two deadlock.
    if (REDIRECTED.has(specifier) && !(context.parentURL ?? "").startsWith(SHIM)) {
      return { url: `${SHIM}?m=${encodeURIComponent(specifier)}`, shortCircuit: true };
    }
    return next(specifier, context);
  },
});

const count = (fn) =>
  new Proxy(fn, {
    apply(target, self, args) {
      globalThis.__harnessAssertions += 1;
      return Reflect.apply(target, self, args);
    },
  });

// node:assert/strict and assert.strict are the same object. Without the
// identity check a two-assertion suite reports four -- a gate claiming
// more verification than happened. Verified by removing it.
const seen = new Set();
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
    fs.appendFileSync(target, `${globalThis.__harnessAssertions}\n`);
  } catch {
    // Nothing to do from inside an exit handler. A missing count reads as
    // zero, which fails the gate closed.
  }
});
