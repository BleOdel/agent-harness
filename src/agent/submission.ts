/** Completed work and requests for operator input share one submission file. */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CLAIM_FILE, type Claim, parseClaim } from "../gates/claim.ts";

export type Submission =
  | { readonly ok: true; readonly outcome: "completed"; readonly claim: Claim }
  | { readonly ok: true; readonly outcome: "blocked"; readonly reason: string; readonly requestedInput: string }
  | { readonly ok: false; readonly reason: string };

export function parseSubmission(text: string): Submission {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, reason: `${CLAIM_FILE} is not valid JSON.` }; }
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const record = raw as Record<string, unknown>;
    if (record.outcome === "blocked") {
      if (typeof record.reason !== "string" || record.reason.trim() === ""
        || typeof record.requestedInput !== "string" || record.requestedInput.trim() === "") {
        return { ok: false, reason: "A blocked submission needs a nonempty reason and requestedInput." };
      }
      return { ok: true, outcome: "blocked", reason: record.reason.trim(), requestedInput: record.requestedInput.trim() };
    }
  }
  const result = parseClaim(text);
  return result.ok ? { ok: true, outcome: "completed", claim: result.claim } : result;
}

export async function readSubmission(directory: string): Promise<Submission> {
  const text = await readFile(path.join(directory, CLAIM_FILE), "utf8").catch(() => undefined);
  return text === undefined ? { ok: false, reason: `${CLAIM_FILE} was not written.` } : parseSubmission(text);
}
