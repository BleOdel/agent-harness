/** Shared team transitions. Immutable events remain the authority for legacy and current runs. */
import path from 'node:path';
import { assertExecutionPin } from '../project/execution.ts';
import { checkPolicy, digest, identifier, parseTeamPlan, type TeamEvent, type TeamState, type Usage } from '../team/schema.ts';
import { acceptedTasks, budgetReason, schedule } from '../team/scheduler.ts';
import type { Snapshot } from '../workspace/candidate.ts';
function snapshot(value: Snapshot): void {
    if (!value || typeof value.directory !== "string" || !path.isAbsolute(value.directory) || !/^[a-f0-9]{64}$/u.test(value.digest) || !value.files || typeof value.files !== "object")
        throw new Error("Invalid source snapshot in event.");
}
function usage(state: TeamState, value: Usage | undefined): void {
    if (value === undefined) {
        state.usage.complete = false;
        return;
    }
    if (![value.tokens, value.costUsd].every(n => Number.isFinite(n) && n >= 0) || typeof value.complete !== "boolean")
        throw new Error("Invalid reported usage.");
    state.usage.tokens += value.tokens;
    state.usage.costUsd += value.costUsd;
    state.usage.complete = state.usage.complete && value.complete;
}
export function reduceTeam(previous: TeamState | undefined, event: TeamEvent): TeamState {
    if (event.operationId !== undefined && !identifier(event.operationId))
        throw new Error("Invalid team operation identity.");
    if (![1, 2, 3, 4].includes(event.version) || (previous !== undefined && event.version !== previous.version) || event.seq !== (previous?.seq ?? 0) + 1 || !identifier(event.runId) || !Number.isFinite(Date.parse(event.at)))
        throw new Error("Unsupported or out-of-sequence team event.");
    if (event.type === "created") {
        if (previous)
            throw new Error("Duplicate team creation.");
        const plan = parseTeamPlan(event.plan, event.plan.tasks);
        checkPolicy(event.policy);
        snapshot(event.baseline);
        if (digest(plan) !== event.planDigest)
            throw new Error("Accepted plan digest mismatch.");
        if (event.version >= 4) {
            assertExecutionPin(event.execution!);
            if (event.baseline.executionDigest !== event.execution!.digest)
                throw new Error("Baseline execution identity does not match the run.");
        }
        return { ...(event.execution ? { execution: event.execution } : {}), ...(event.verificationDigest === undefined ? {} : { verificationDigest: event.verificationDigest }), version: event.version, runId: event.runId, seq: event.seq, startedAt: event.at, plan, planDigest: event.planDigest, policy: event.policy, original: event.baseline, baseline: event.baseline, attempts: [], integrated: [], invalidated: [], status: "running", usage: { tokens: 0, costUsd: 0, complete: true } };
    }
    if (!previous || event.runId !== previous.runId)
        throw new Error("Event belongs to another or missing team run.");
    const state = structuredClone(previous);
    state.seq = event.seq;
    if (event.type === "resumed") {
        if (state.version < 2 || !["running", "stopped"].includes(state.status) || state.attempts.some(a => ["running", "submitted", "verified"].includes(a.status)))
            throw new Error("Resume requires reconciled unfinished attempts and an unapplied run.");
        state.status = "running";
        state.resumeSeq = event.seq;
        delete state.reason;
        delete state.finishedAt;
        return state;
    }
    if (event.type === "application-started") {
        if (state.version < 2 || !identifier(event.transactionId) || state.status !== (event.direction === "apply" ? "staged" : "applied"))
            throw new Error("Application requires staged work, or an applied batch for undo.");
        state.application = { transactionId: event.transactionId, intentDigest: event.intentDigest, direction: event.direction };
        state.status = "applying";
        return state;
    }
    if (event.type === "application-completed" || event.type === "application-rolled-back") {
        if (state.status !== "applying" || state.application?.transactionId !== event.transactionId || state.application.direction !== event.direction)
            throw new Error("Application completion does not match its pending transaction.");
        if (event.type === "application-completed") {
            state.application.recordId = event.recordId;
            state.status = event.direction === "apply" ? "applied" : "undone";
            if (event.direction === "apply") {
                state.appliedRecordId = event.recordId;
                state.appliedTransactionId = event.transactionId;
                state.appliedIntentDigest = state.application.intentDigest;
            }
            else {
                state.invalidated = [...new Set([...state.invalidated, ...state.integrated])];
                state.integrated = [];
            }
        }
        else {
            state.status = event.direction === "apply" ? "staged" : "applied";
            delete state.application;
        }
        return state;
    }
    if (event.type === "stopped" || event.type === "staged" || event.type === "aborted") {
        if (!["running", "stopped", "staged"].includes(state.status))
            throw new Error("Cannot change a terminal application state.");
        if (state.attempts.some(a => ["running", "submitted", "verified"].includes(a.status)))
            throw new Error("Cannot stop with an unfinished attempt.");
        if (event.type === "staged" && state.plan.tasks.some(t => t.priority !== "wont" && !acceptedTasks(state).has(t.id)))
            throw new Error("All requested tasks must be integrated before staging is complete.");
        state.status = event.type;
        state.finishedAt = event.at;
        if (event.type !== "staged")
            state.reason = event.reason;
        return state;
    }
    if (state.status !== "running")
        throw new Error("Team run is terminal.");
    if (event.type === "dispatched") {
        const a = event.attempt;
        if (!identifier(a.id) || state.attempts.some(old => old.id === a.id || old.containerName === a.containerName || old.directory === a.directory))
            throw new Error("Attempt identity must be unique.");
        if (state.version === 1 && state.attempts.some(old => ["running", "submitted", "verified"].includes(old.status)))
            throw new Error("Version 1 permits one active attempt.");
        const task = state.plan.tasks.find(t => t.id === a.taskId);
        if (!task || task.assignedRole !== a.roleId)
            throw new Error("Attempt role does not match accepted assignment.");
        const next = schedule(state);
        if (a.repairOf !== next?.repair?.id || a.repairCandidate?.digest !== next?.repair?.candidate?.digest)
            throw new Error("Repair does not match the eligible failed integration.");
        if (next?.task.id !== a.taskId)
            throw new Error("Task is not the next eligible accepted assignment.");
        const limit = budgetReason(state, Date.parse(event.at));
        if (limit)
            throw new Error(limit);
        snapshot(a.baseline);
        if (a.baseline.digest !== state.baseline.digest || a.baseline.executionDigest !== state.baseline.executionDigest)
            throw new Error("Attempt uses a stale baseline.");
        if (!path.isAbsolute(a.directory) || !/^harness-[a-zA-Z0-9_-]+$/u.test(a.containerName))
            throw new Error("Invalid attempt resource identity.");
        if (state.execution && a.executionDigest !== state.execution.digest)
            throw new Error("Attempt execution identity changed.");
        state.attempts.push({ ...a, startedAt: event.at, status: "running" });
        return state;
    }
    const attempt = state.attempts.find(a => a.id === event.attemptId);
    if (!attempt)
        throw new Error("Result does not name a host-issued attempt.");
    switch (event.type) {
        case "review-usage":
            if (attempt.status !== "submitted")
                throw new Error("Review usage requires a submitted candidate.");
            usage(state, event.usage);
            attempt.reviewerUsage = event.usage;
            break;
        case "submitted":
            if (attempt.status !== "running")
                throw new Error("Only a running attempt can submit.");
            if (state.execution && event.candidate.executionDigest !== state.execution.digest)
                throw new Error("Candidate execution identity changed.");
            snapshot(event.candidate);
            attempt.candidate = event.candidate;
            attempt.status = "submitted";
            if (!Array.isArray(event.observedReads) || !Array.isArray(event.workflowEvidence))
                throw new Error("Invalid skill evidence.");
            usage(state, event.usage);
            attempt.usage = event.usage;
            break;
        case "verified":
            if (attempt.status !== "submitted" || event.review !== "pass" || !Array.isArray(event.gates) || event.gates.length === 0)
                throw new Error("Verification requires a submitted candidate, gate evidence and passing review.");
            if (state.execution && (event.executionDigest !== state.execution.digest || !event.environmentKey))
                throw new Error("Verification execution evidence is missing or changed.");
            if (event.environmentKey)
                attempt.environmentKey = event.environmentKey;
            attempt.status = "verified";
            break;
        case "integration-verified":
            if (state.version < 2 || attempt.status !== "verified" || attempt.integration || event.fromDigest !== state.baseline.digest || event.candidateDigest !== attempt.candidate?.digest || !Array.isArray(event.gates) || event.gates.length === 0)
                throw new Error("Integration requires the current staging, verified candidate and gate evidence.");
            if (state.execution && (event.executionDigest !== state.execution.digest || event.proposal.executionDigest !== state.execution.digest || !event.environmentKey))
                throw new Error("Integration execution evidence is missing or changed.");
            snapshot(event.proposal);
            attempt.integration = { fromDigest: event.fromDigest, proposal: event.proposal, ...(event.environmentKey ? { environmentKey: event.environmentKey } : {}), ...(event.executionDigest ? { executionDigest: event.executionDigest } : {}) };
            break;
        case "integrated":
            if (attempt.status !== "verified")
                throw new Error("Only a verified candidate can advance staging.");
            snapshot(event.baseline);
            if (state.execution && event.baseline.executionDigest !== state.execution.digest)
                throw new Error("Integrated baseline execution identity changed.");
            if (state.version === 1 ? event.baseline.digest !== attempt.candidate?.digest : !attempt.integration || attempt.integration.fromDigest !== state.baseline.digest || event.baseline.digest !== attempt.integration.proposal.digest)
                throw new Error("Staging must contain the verified integration bytes from the current baseline.");
            const task = state.plan.tasks.find(t => t.id === attempt.taskId)!;
            if (task.kind === "shared-inputs" && event.baseline.digest !== state.baseline.digest) {
                state.invalidated = [...new Set([...state.invalidated, ...state.integrated, ...state.plan.tasks.filter(t => t.status === "done").map(t => t.id)])];
                state.integrated = [];
            }
            state.invalidated = state.invalidated.filter(id => id !== attempt.taskId);
            attempt.status = "integrated";
            attempt.finishedAt = event.at;
            state.baseline = event.baseline;
            state.integrated = [...new Set([...state.integrated, attempt.taskId])];
            break;
        case "failed":
        case "blocked":
        case "interrupted":
            if (!["running", "submitted", "verified"].includes(attempt.status) || typeof event.reason !== "string" || !event.reason)
                throw new Error("Invalid terminal attempt transition.");
            if (attempt.status === "running") {
                usage(state, event.usage);
                if (event.usage)
                    attempt.usage = event.usage;
            }
            attempt.status = event.type;
            attempt.finishedAt = event.at;
            attempt.reason = event.reason;
            attempt.terminalSeq = event.seq;
            if (event.failureStage)
                attempt.failureStage = event.failureStage;
            break;
        default: throw new Error("Unknown team event.");
    }
    return state;
}
