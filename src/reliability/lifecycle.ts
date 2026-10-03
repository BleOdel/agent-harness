/** Version-one interchange contracts. Existing stores remain authoritative until their adapter is migrated. */
export interface Binding { taskId: string; requirements: string; source: string; approval: string | null; runtime: string | null; }
interface Base { version: 1; id: string; revision: number; binding: Binding; }
export interface TaskRecord extends Base { kind: 'task'; requirementsRef: string; }
export type Phase = 'preparing' | 'building' | 'verifying' | 'reviewing' | 'applying';
export type Outcome = 'none' | 'provider-interruption' | 'capability-gap' | 'requirement-conflict' | 'candidate-rejected' | 'allowance-exhausted' | 'pending-application' | 'succeeded';
export interface OperationRecord extends Base {
  kind: 'operation'; phase: Phase; status: 'pending' | 'running' | 'paused' | 'attention' | 'completed';
  outcome: Outcome; reservations: string[]; evidence: string[];
}
export interface CandidateRecord extends Base { kind: 'candidate'; digest: string; metadataVersion: 1 | 2; artifactRef: string; }
export interface EvidenceRecord extends Base {
  kind: 'evidence'; candidate: string; producer: string; evidenceKind: 'design' | 'automatic' | 'source-review' | 'human';
  verdict: 'passed' | 'failed' | 'incomplete'; artifactRef: string; limitations: string[];
}
export interface DecisionRecord extends Base {
  kind: 'decision'; candidate: string | null; operation: string; decision: 'approve' | 'reject' | 'defer';
  purpose: 'requirements' | 'amendment' | 'application' | 'release' | 'allowance'; evidence: string[];
}
export type LifecycleRecord = TaskRecord | OperationRecord | CandidateRecord | EvidenceRecord | DecisionRecord;
const phases: Phase[] = ['preparing', 'building', 'verifying', 'reviewing', 'applying'];
const outcomes: Outcome[] = ['none', 'provider-interruption', 'capability-gap', 'requirement-conflict', 'candidate-rejected', 'allowance-exhausted', 'pending-application', 'succeeded'];
function object(raw: unknown, fields: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error('Expected lifecycle object.');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== fields.length || Object.keys(value).some(k => !fields.includes(k))) throw Error('Unexpected or missing lifecycle fields.');
  return value;
}
const identifier = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/u.test(v);
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
const references = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 10000 && v.every(identifier) && new Set(v).size === v.length;
function binding(raw: unknown): Binding {
  const b = object(raw, ['taskId', 'requirements', 'source', 'approval', 'runtime']);
  if (!identifier(b.taskId) || !digest(b.requirements) || !digest(b.source) || (b.approval !== null && !digest(b.approval)) || (b.runtime !== null && !digest(b.runtime))) throw Error('Invalid lifecycle binding.');
  return b as unknown as Binding;
}
export function parseLifecycleRecord(raw: unknown): LifecycleRecord {
  const kind = (raw as { kind?: unknown } | null)?.kind;
  const fields = ['version', 'kind', 'id', 'revision', 'binding'];
  const extra: Record<string, string[]> = {
    task: ['requirementsRef'], operation: ['phase', 'status', 'outcome', 'reservations', 'evidence'],
    candidate: ['digest', 'metadataVersion', 'artifactRef'],
    evidence: ['candidate', 'producer', 'evidenceKind', 'verdict', 'artifactRef', 'limitations'],
    decision: ['candidate', 'operation', 'decision', 'purpose', 'evidence'],
  };
  if (typeof kind !== 'string' || !Object.hasOwn(extra, kind)) throw Error('Unknown lifecycle record kind.');
  const r = object(raw, [...fields, ...extra[kind]!]);
  if (r.version !== 1 || !identifier(r.id) || !Number.isSafeInteger(r.revision) || Number(r.revision) < 0) throw Error('Invalid lifecycle version or identity.');
  binding(r.binding);
  if (kind === 'task' && !identifier(r.requirementsRef)) throw Error('Invalid requirement reference.');
  if (kind === 'candidate' && (!digest(r.digest) || ![1, 2].includes(Number(r.metadataVersion)) || typeof r.metadataVersion !== 'number' || !identifier(r.artifactRef))) throw Error('Invalid candidate identity.');
  if (kind === 'operation') {
    if (!phases.includes(r.phase as Phase) || !['pending', 'running', 'paused', 'attention', 'completed'].includes(r.status as string) || !outcomes.includes(r.outcome as Outcome) || !references(r.reservations) || !references(r.evidence)) throw Error('Invalid operation state.');
    if ((r.status === 'completed') !== (r.outcome === 'succeeded') || (r.status === 'completed' && !(r.evidence as string[]).length)) throw Error('Completion requires evidence, not a process exit.');
    if ((r.status === 'pending' || r.status === 'running') && r.outcome !== 'none') throw Error('Active operation cannot carry a terminal outcome.');
    if (r.status === 'paused' && !['provider-interruption', 'allowance-exhausted'].includes(r.outcome as string)) throw Error('Invalid pause outcome.');
    if (r.status === 'attention' && !['capability-gap', 'requirement-conflict', 'candidate-rejected', 'pending-application'].includes(r.outcome as string)) throw Error('Invalid attention outcome.');
  }
  if (kind === 'evidence' && (!digest(r.candidate) || !identifier(r.producer) || !identifier(r.artifactRef) || !['design', 'automatic', 'source-review', 'human'].includes(r.evidenceKind as string) || !['passed', 'failed', 'incomplete'].includes(r.verdict as string) || !Array.isArray(r.limitations) || r.limitations.some(v => typeof v !== 'string' || !v.trim() || v.length > 4000))) throw Error('Invalid evidence record.');
  if (kind === 'decision' && ((r.candidate !== null && !digest(r.candidate)) || !identifier(r.operation) || !['approve', 'reject', 'defer'].includes(r.decision as string) || !['requirements', 'amendment', 'application', 'release', 'allowance'].includes(r.purpose as string) || !references(r.evidence))) throw Error('Invalid decision record.');
  if (kind === 'decision' && r.decision === 'approve' && ['application', 'release'].includes(r.purpose as string) && (!digest(r.candidate) || !(r.evidence as string[]).length)) throw Error('Final approval requires an exact candidate and evidence.');
  return structuredClone(raw) as LifecycleRecord;
}
export type OperationEvent =
  | { type: 'start' }
  | { type: 'reserve'; requestId: string }
  | { type: 'pause'; outcome: 'provider-interruption' | 'allowance-exhausted' }
  | { type: 'attention'; outcome: 'capability-gap' | 'requirement-conflict' | 'candidate-rejected' | 'pending-application' }
  | { type: 'advance'; phase: Phase }
  | { type: 'finish'; evidence: string[] };

/** Pure compare-and-swap transition; durable stores must publish it atomically under their writer lock. */
export function transitionOperation(raw: OperationRecord, expectedRevision: number, event: OperationEvent): OperationRecord {
  const parsed = parseLifecycleRecord(raw);
  if (parsed.kind !== 'operation') throw Error('Expected operation record.');
  if (parsed.revision !== expectedRevision) throw Error('Stale operation revision.');
  const next = structuredClone(parsed);
  if (event.type === 'start') {
    if (next.status !== 'pending' && next.status !== 'paused') throw Error('Operation cannot start in this state.');
    next.status = 'running'; next.outcome = 'none';
  } else {
    if (next.status !== 'running') throw Error('Only a running operation can transition.');
    if (event.type === 'reserve') {
      if (!identifier(event.requestId) || next.reservations.includes(event.requestId)) throw Error('Invalid or duplicate request reservation.');
      next.reservations.push(event.requestId);
    } else if (event.type === 'pause' || event.type === 'attention') {
      next.status = event.type === 'pause' ? 'paused' : 'attention'; next.outcome = event.outcome;
    } else if (event.type === 'advance') {
      if (phases.indexOf(event.phase) !== phases.indexOf(next.phase) + 1) throw Error('Invalid phase transition.');
      if (!next.binding.approval) throw Error('An approved binding is required before advancing implementation.');
      next.phase = event.phase;
    } else if (event.type === 'finish') {
      if (!references(event.evidence) || event.evidence.length === 0 || (next.phase === 'applying' && !next.binding.approval)) throw Error('Completion requires bound evidence; application also requires approval.');
      next.status = 'completed'; next.outcome = 'succeeded'; next.evidence = [...event.evidence];
    } else throw Error('Unknown operation event.');
  }
  next.revision++;
  return parseLifecycleRecord(next) as OperationRecord;
}

/** Legacy state stays read-only here; unknown schemas cannot gain invented evidence or metadata. */
export interface LegacyReference { version: 1; owner: 'features' | 'preparation' | 'review-progress' | 'implementation' | 'stage' | 'team'; digest: string; }
export function legacyReference(owner: LegacyReference['owner'], digestValue: string): LegacyReference {
  if (!['features', 'preparation', 'review-progress', 'implementation', 'stage', 'team'].includes(owner) || !digest(digestValue)) throw Error('Invalid legacy state reference.');
  return { version: 1, owner, digest: digestValue };
}
