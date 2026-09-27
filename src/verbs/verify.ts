import {assertProductCurrent} from "../product/spec.ts";
import {recordDiagnostics,type Diagnostic} from "../product/report.ts";
import {readFeatures} from "../features.ts";
import {requireChecks,verifyAcceptance} from "../acceptance/checks.ts";
import {assertLiveBaseline} from "../workspace/candidate.ts";
/** Run project diagnostics without a builder, provider call or source application. */
import { randomUUID } from 'node:crypto';
import { buildOutputs } from '../artifacts/outputs.ts';
import { putArtifact, sha256, saveJson, stateRoot } from '../artifacts/store.ts';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getAdapter } from '../adapters/registry.ts';
import { loadConfig, setting } from '../config.ts';
import { counterPath } from '../gates/tests.ts';
import { executionLayout, inspectCapabilities } from '../project/execution.ts';
import { projectTestCommand, readProfile } from '../project/profile.ts';
import { assertSnapshot, captureBaseline } from '../workspace/candidate.ts';
import { withWriter } from '../workspace/writer-lock.ts';
import { OperatorError, say } from './io.ts';
export async function verify(project: string, args: readonly string[] = []): Promise<void> {
 if (args.length && (args.length!==1 || !['--retain','--acceptance'].includes(args[0]!))) throw new OperatorError('Use: harness verify [--retain | --acceptance]');
 const retain=args[0]==='--retain', acceptance=args[0]==='--acceptance';
 return withWriter(project, 'verify', async () => {
  const product=await assertProductCurrent(project);
  if(acceptance&&!product)throw new OperatorError('Approve a product specification first.','Run harness product setup.');
  const features=acceptance?await readFeatures(project):undefined;
  const tasks=features?.ok?features.features.filter(t=>t.priority!=='wont').map(t=>t.id):[];
  const approved=acceptance?await requireChecks(project,tasks):undefined;
  const config = loadConfig({ ...process.env, HARNESS_PROJECT: project }), profile = await readProfile(project), adapter = getAdapter(profile.adapter);
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'harness-local-verification-')));
  try {
   const source = await captureBaseline(project, path.join(root, 'source'), adapter.source.generatedDirectories);
   await recordDiagnostics(project,source.digest,[{name:"execution",status:"failed",summary:"Verification started but has not completed; rerun after interruption."}]);
   const capabilities = await inspectCapabilities(profile, config);
   const layout = { ...executionLayout(config, source.directory, `harness-verify-${process.pid}`), ...(adapter.executionEnvironment ? { environment: adapter.executionEnvironment } : {}) };
   say(`Preparing ${adapter.reference.id}@${adapter.reference.version}; tests and packaging run in fresh offline containers.`);
   const environment = await adapter.prepare(source.directory, path.join(root, 'environment'), layout, config.gateTimeoutMs, config.installPolicy);
   const recipe = await adapter.recipe(source.directory, await projectTestCommand(project, setting(process.env, 'HARNESS_TEST_COMMAND')));
   const runtime={image:config.imageId,testCommand:recipe.testCommand};
   const checks = await adapter.checks(source.directory, recipe, await readFile(counterPath(), 'utf8'), config.gateTimeoutMs);
   let outputs: Awaited<ReturnType<typeof buildOutputs>> = [];
   const diagnostics:Diagnostic[]=[];
   try {
   for (const [index, check] of checks.entries()) {
    if (!check.applies) { diagnostics.push({name:check.name,status:"skipped",summary:"Not applicable"}); say(`${check.name}: not applicable`); continue; }
    const work = path.join(root, `check-${index}`);
    await adapter.install(source.directory, work, environment, layout, config.gateTimeoutMs); await adapter.pin(work, recipe);
    const verdict = await check.check({ ...layout, workDirectory: work }); say(verdict.summary);
    diagnostics.push({name:check.name,status:verdict.passed?"passed":"failed",summary:verdict.summary});
    if (!verdict.passed) throw new OperatorError(verdict.summary, verdict.detail);
    await assertSnapshot(source);
    if (retain && check.name === "build") outputs = await buildOutputs(work, adapter.artifacts);
   }
   } catch(error) {
    if(!diagnostics.some(c=>c.status==="failed"))diagnostics.push({name:"execution",status:"failed",summary:(error as Error).message});
    if(diagnostics.some(c=>c.name==="tests"&&c.status!=="skipped"))await recordDiagnostics(project,source.digest,diagnostics,runtime);
    throw error;
   }
   await assertLiveBaseline(project,source);
   await recordDiagnostics(project,source.digest,diagnostics,runtime);
   if(approved){const result=await verifyAcceptance(project,source,tasks,config,approved);result.summaries.forEach(say);await assertLiveBaseline(project,source);}
   if (retain) {
    const producer=`verify-${randomUUID()}`, details={version:1,producer,source:source.digest,profile,capabilities,environment:environment.key}, identity=sha256(JSON.stringify(details));
    await saveJson(await stateRoot(project),`${producer}.json`,details);
    for (const output of outputs) {const artifact=await putArtifact(project,output.name,output.bytes,{producer,input:source.digest,environment:identity,verification:'diagnostics-passed'});say(`Retained ${output.name}: ${artifact.id}. Inspect/export through harness artifacts.`);}
    if(!outputs.length)say('No declared build outputs to retain. Job outputs can be retained through harness job setup.');
   }
   say('Project diagnostics passed. No changes applied; builds still require approved acceptance checks.');
  } finally { await rm(root, { recursive: true, force: true }); }
 });
}
