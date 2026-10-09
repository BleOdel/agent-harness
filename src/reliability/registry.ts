import { readFile } from 'node:fs/promises';

export interface Qualification {
  state: 'inspection-only' | 'unexecuted' | 'reproduced' | 'fixed';
  trigger: string; regression: string | null; execution: string | null; limitation: string;
}
export interface Finding {
  id: string; title: string; priority: 'P1' | 'P2'; confidence: string;
  problem: string; impact: string; fix: string; verify: string; refs: string[];
  qualification?: Qualification;
  status: 'open' | 'verified'; tasks: string[]; regressions: string[];
  resolutionEvidence: { kind: 'regression' | 'negative-control'; path: string }[];
}
export interface Registry {
  version: 1 | 2; qualificationReport?: string; auditedCommit: string; auditedAt: string;
  baseline: { kind: 'historical-audit'; tests: number; passed: number; skipped: number; failed: number; limitation: string };
  findings: Finding[];
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid audit registry object.');
  return value as Record<string, unknown>;
}
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const path = (value: unknown): value is string => text(value) && !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..');
export function parseRegistry(value: unknown): Registry {
  const r = record(value), baseline = record(r.baseline);
  if (![1, 2].includes(r.version as number) || typeof r.auditedCommit !== 'string' || !/^[a-f0-9]{40}$/u.test(r.auditedCommit) || !text(r.auditedAt) || !Number.isFinite(Date.parse(r.auditedAt))) throw Error('Invalid audit version/identity.');
  if (baseline.kind !== 'historical-audit' || !text(baseline.limitation)) throw Error('Historical audit evidence must remain labeled.');
  for (const field of ['tests', 'passed', 'failed', 'skipped']) if (!Number.isSafeInteger(baseline[field]) || Number(baseline[field]) < 0) throw Error('Invalid audit baseline counts.');
  if (baseline.tests !== Number(baseline.passed) + Number(baseline.failed) + Number(baseline.skipped)) throw Error('Audit baseline counts disagree.');
  if (!Array.isArray(r.findings) || r.findings.length === 0) throw Error('Audit registry needs findings.');
  if (r.version === 2 && !path(r.qualificationReport)) throw Error('Missing qualification report.');
  const ids = new Set<string>();
  for (const raw of r.findings) {
    const f = record(raw);
    if (typeof f.id !== 'string' || !/^F\d{2}$/u.test(f.id) || ids.has(f.id)) throw Error('Invalid or duplicate finding ID.');
    ids.add(f.id);
    for (const key of ['title', 'confidence', 'problem', 'impact', 'fix', 'verify']) if (!text(f[key])) throw Error(`Missing finding ${key}.`);
    if (!['P1', 'P2'].includes(f.priority as string) || !['open', 'verified'].includes(f.status as string)) throw Error('Invalid finding status/priority.');
    if (!Array.isArray(f.tasks) || !f.tasks.length || f.tasks.some(id => typeof id !== 'string' || !/^hr-\d{3}$/u.test(id))) throw Error('Finding must map to implementation tasks.');
    for (const key of ['refs', 'regressions']) if (!Array.isArray(f[key]) || (f[key] as unknown[]).some(p => !path(p))) throw Error('Invalid audit reference.');
    if (!(f.refs as unknown[]).length || !Array.isArray(f.resolutionEvidence)) throw Error('Missing finding references/evidence.');
    const kinds = new Set<string>();
    for (const rawEvidence of f.resolutionEvidence) {
      const e = record(rawEvidence);
      if (!['regression', 'negative-control'].includes(e.kind as string) || !path(e.path)) throw Error('Invalid resolution evidence.');
      kinds.add(e.kind as string);
    }
    if (f.status === 'verified' && (!(f.regressions as unknown[]).length || !kinds.has('regression') || !kinds.has('negative-control'))) throw Error('A verified finding needs regression and negative-control evidence.');
    if (r.version === 2 || f.qualification !== undefined) {
      const q = record(f.qualification);
      if (!['inspection-only','unexecuted','reproduced','fixed'].includes(q.state as string) || !text(q.trigger) || !text(q.limitation) || (q.regression !== null && !path(q.regression)) || (q.execution !== null && !path(q.execution))) throw Error('Invalid finding qualification.');
      if ((q.state === 'reproduced' || q.state === 'fixed') && (!path(q.regression) || !path(q.execution))) throw Error('Executed qualification needs a regression and execution reference.');
      if (q.state === 'unexecuted' && (!path(q.regression) || q.execution !== null)) throw Error('An unexecuted regression cannot claim execution.');
      if ((q.state === 'fixed') !== (f.status === 'verified')) throw Error('Only a verified finding may be qualified fixed.');
    }
  }
  return structuredClone(value) as Registry;
}
export async function readRegistry(): Promise<Registry> {
  return parseRegistry(JSON.parse(await readFile(new URL('../../docs/reliability/findings.json', import.meta.url), 'utf8')));
}
