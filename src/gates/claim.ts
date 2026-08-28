/**
 * What the model says it did, in a form a machine can check against what
 * it actually did.
 *
 * v1's most expensive failure mode was victory declaration: a confident
 * summary of work that was not finished, believed because nothing
 * compared the summary to the result. Prose cannot be checked. A list of
 * files and a list of acceptance criteria can be.
 *
 * This does not make the model honest, and it is not meant to. It makes
 * dishonesty *specific*: the model must name the files and name the
 * criteria, and if the names do not match reality the run stops. What it
 * cannot do is judge whether the work was the work that was asked for --
 * that is a human question, and it is what M3's Reviewer is for.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Change } from "../workspace/changes.ts";
import { failed, type GateVerdict, passed } from "./gate.ts";

/** Written by the model into the copy. Never applied to the project. */
export const CLAIM_FILE = ".harness-claim.json";

export interface Claim {
  readonly files: readonly string[];
  readonly deletions: readonly string[];
  readonly criteria: readonly { readonly criterion: string; readonly verifiedBy: string }[];
}

export type ClaimResult =
  | { readonly ok: true; readonly claim: Claim }
  | { readonly ok: false; readonly reason: string };

function asStringArray(value: unknown, field: string): string[] | string {
  if (!Array.isArray(value)) return `"${field}" must be an array of strings.`;
  const bad = value.find((entry) => typeof entry !== "string");
  return bad === undefined ? (value as string[]) : `"${field}" contains a non-string entry.`;
}

export function parseClaim(text: string): ClaimResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: `${CLAIM_FILE} is not valid JSON: ${(error as Error).message}` };
  }
  // Array.isArray as well as the typeof: a JSON array is an object, and
  // without this it falls through to a complaint about "criteria" that
  // sends the reader looking in the wrong place.
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: `${CLAIM_FILE} must be a JSON object.` };
  }
  const record = raw as Record<string, unknown>;

  const files = asStringArray(record.files ?? [], "files");
  if (typeof files === "string") return { ok: false, reason: files };
  const deletions = asStringArray(record.deletions ?? [], "deletions");
  if (typeof deletions === "string") return { ok: false, reason: deletions };

  if (!Array.isArray(record.criteria)) {
    return { ok: false, reason: '"criteria" must be an array.' };
  }
  const criteria: { criterion: string; verifiedBy: string }[] = [];
  for (const entry of record.criteria) {
    const item = entry as Record<string, unknown>;
    if (typeof item?.criterion !== "string" || typeof item.verifiedBy !== "string") {
      return {
        ok: false,
        reason: 'each entry in "criteria" needs a string "criterion" and a string "verifiedBy".',
      };
    }
    criteria.push({ criterion: item.criterion, verifiedBy: item.verifiedBy });
  }
  return { ok: true, claim: { files, deletions, criteria } };
}

export async function readClaim(workDirectory: string): Promise<ClaimResult> {
  let text;
  try {
    text = await readFile(path.join(workDirectory, CLAIM_FILE), "utf8");
  } catch {
    return {
      ok: false,
      reason:
        `${CLAIM_FILE} was not written. Every run must state what it produced, `
        + "because a summary nothing checks is the failure mode this gate exists for.",
    };
  }
  return parseClaim(text);
}

/**
 * The claim against the change set.
 *
 * Both directions matter, and the second one more. A file changed and not
 * declared is the interesting case: it is the edit the summary did not
 * mention. A file declared and not changed is the claim that describes
 * work that did not happen.
 */
export function checkClaim(claim: Claim, changes: readonly Change[]): GateVerdict {
  const changed = new Set(changes.filter((c) => c.kind !== "deleted").map((c) => c.file));
  const deleted = new Set(changes.filter((c) => c.kind === "deleted").map((c) => c.file));
  // The claim file is harness machinery, not project work: it is stripped
  // from the change set before this runs and never applied. A model that
  // lists it is telling the truth -- it did write it -- so refusing that
  // is punishing honesty for a discrepancy the harness itself created.
  // Cost a live run its second attempt before it was noticed.
  const declaredFiles = new Set(claim.files.filter((file) => file !== CLAIM_FILE));
  const declaredDeletions = new Set(claim.deletions.filter((file) => file !== CLAIM_FILE));

  const problems: string[] = [];
  for (const file of changed) {
    if (!declaredFiles.has(file)) problems.push(`  changed but not declared:   ${file}`);
  }
  for (const file of declaredFiles) {
    if (!changed.has(file)) problems.push(`  declared but not changed:   ${file}`);
  }
  for (const file of deleted) {
    if (!declaredDeletions.has(file)) problems.push(`  deleted but not declared:   ${file}`);
  }
  for (const file of declaredDeletions) {
    if (!deleted.has(file)) problems.push(`  declared deleted, still here: ${file}`);
  }

  if (problems.length > 0) {
    return failed(
      "claim-mismatch",
      `claim: ${String(problems.length)} discrepancies between what was claimed and what changed`,
      [`${CLAIM_FILE} does not describe this change:`, "", ...problems.sort()].join("\n"),
    );
  }
  if (claim.criteria.length === 0) {
    return failed(
      "claim-mismatch",
      "claim: no acceptance criteria were accounted for",
      "Every criterion the work was asked to satisfy must be listed, with the file that verifies it.",
    );
  }
  return passed(
    `claim: ${String(changes.length)} changes declared, ${String(claim.criteria.length)} criteria accounted for`,
  );
}

/**
 * Every criterion must point at a file that exists and that actually
 * changed or was consulted. Checked separately from the shape above so a
 * criterion pointing at a plausible-sounding file that was never written
 * is caught by name rather than by trust.
 */
export function checkCriteriaEvidence(claim: Claim, presentFiles: ReadonlySet<string>): GateVerdict {
  const missing = claim.criteria.filter((entry) => !presentFiles.has(entry.verifiedBy));
  if (missing.length > 0) {
    return failed(
      "claim-mismatch",
      `claim: ${String(missing.length)} criteria point at files that do not exist`,
      [
        "A criterion is only accounted for if something real verifies it.",
        "",
        ...missing.map((entry) => `  ${entry.verifiedBy}  (claimed to verify: ${entry.criterion})`),
      ].join("\n"),
    );
  }
  return passed(`claim: all ${String(claim.criteria.length)} criteria point at real files`);
}
