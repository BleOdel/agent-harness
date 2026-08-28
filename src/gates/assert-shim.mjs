/**
 * Stands in for `node:assert` and `node:assert/strict` inside a gate run.
 *
 * Every export is wrapped so a call is counted however it was imported.
 * The module-object patch in assert-counter.mjs cannot do this on its
 * own: `import { equal } from "node:assert/strict"` binds to the original
 * function when the module is linked, so patching the object afterwards
 * never reaches it.
 *
 * That is not a hypothetical. It was found by a real run in which the
 * model wrote a fully tested module using named imports, the gate counted
 * zero assertions, and the run was refused twice -- honest work rejected
 * by the check meant to protect it.
 */

import { createRequire } from "node:module";

const which = new URL(import.meta.url).searchParams.get("m") ?? "node:assert";
// require rather than import: a dynamic import here is intercepted by the
// very hook that loaded this file, and the two deadlock.
const real = createRequire(import.meta.url)(
  which.includes("strict") ? "node:assert/strict" : "node:assert",
);

// Deliberately does no wrapping of its own. assert-counter.mjs has
// already replaced this module's function properties with counting
// versions, so re-exporting them is enough -- and wrapping again here
// counted every call twice, which a gate must never do in either
// direction. Measured: six assertions reported as eleven.
const wrapped = real;

export default wrapped;
export const {
  ok, equal, strictEqual, notEqual, notStrictEqual,
  deepEqual, deepStrictEqual, notDeepEqual, notDeepStrictEqual,
  match, doesNotMatch, throws, doesNotThrow, rejects, doesNotReject,
  fail, ifError, strict, partialDeepStrictEqual,
} = wrapped;
