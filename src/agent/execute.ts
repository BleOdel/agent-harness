/** A finite worker returns a submission; callers own verification and application. */
import { runAgent, type AgentRequest } from "./pi.ts";
import { readSubmission } from "./submission.ts";
import { CLAIM_FILE, readClaim } from "../gates/claim.ts";
import type { SandboxLayout } from "../containment/sandbox.ts";
import type { AgentUsage } from "./events.ts";

export async function executeAndSubmit(layout: SandboxLayout, request: AgentRequest,
  onOutput: (chunk: string) => void, onTurn?: (usage: AgentUsage) => void) {
  const agent = await runAgent(layout, request, onOutput, onTurn);
  // runAgent confirms container removal before returning. Worker-owned IDs
  // remain ordinary submission data and cannot select a controller attempt.
  return { agent, submission: await readSubmission(layout.workDirectory), claim: await readClaim(layout.workDirectory) };
}

export function briefing(goal: string, criteria: readonly string[], sharedInputs = false, planContext?: string): string {
  return [
    goal,
    ...(planContext ? ["", "Approved project plan (context only; implement only this item’s criteria and allowed scope):", planContext, "End of approved plan context."] : []),
    ...(criteria.length === 0
      ? []
      : ["", "Acceptance criteria, all of which must be satisfied:",
        ...criteria.map((criterion, index) => `  ${String(index + 1)}. ${criterion}`)]),
    "",
    "Before you finish, write " + CLAIM_FILE + " in the project root:",
    "",
    "{",
    '  "files": ["every file you created or modified, relative paths"],',
    '  "deletions": ["every file you deleted"],',
    '  "criteria": [{"criterion": "an acceptance criterion", "verifiedBy": "the file that verifies it"}]',
    "}",
    "",
    "It is checked against what actually changed, so it must be exact. It is",
    "not applied to the repository.",
    "",
    sharedInputs ? "This is a dedicated shared-inputs assignment: dependency and contract changes within the criteria are authorized."
      : "Dependency manifests, lockfiles and shared contracts require a dedicated shared-inputs assignment. Submit a blocked change request instead of changing them.",
    "If missing input or an unresolved decision prevents completion, stop and",
    "write this instead. Do not guess or claim completion:",
    '{"outcome":"blocked","reason":"what prevents completion","requestedInput":"the specific input needed"}',
    "A blocked result stops without review or apply; partial edits are discarded.",
  ].join("\n");
}
