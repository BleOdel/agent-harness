import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createTeam, driveTeam, resumeTeam } from "../src/team/controller.ts";
import { parseTeamPlan } from "../src/team/schema.ts";
import { TeamControl } from "../src/team/control.ts";
import { readTeams, formatTeams } from "../src/view/status.ts";
import { emptyUsage } from "../src/agent/events.ts";
import { view } from "../src/verbs/view.ts";

test("team status reconstructs phases, prerequisites, both model roles and steering after controller death", async () => {
 const root=await mkdtemp(path.join(os.tmpdir(),'team-status-')),project=path.join(root,'project');await mkdir(project);
 const tasks=[{id:'api',title:'API',criteria:['works'],priority:'must' as const,status:'todo' as const,dependsOn:[]},{id:'client',title:'Client',criteria:['works'],priority:'must' as const,status:'todo' as const,dependsOn:['api']}];
 await writeFile(path.join(project,'features.json'),JSON.stringify(tasks));const dir=await createTeam(project,parseTeamPlan({version:1,roles:[{id:'b',instructions:'build',skills:[]}],skills:[]},tasks),root,{maxAttempts:1,maxDispatches:2,maxMs:60000,maxCostUsd:0.01});const c=await TeamControl.start(dir);
 try {
  await assert.rejects(driveTeam(dir,{async execute(a){await c.record({type:'phase',attemptId:a.id,phase:'reviewing',modelRole:'reviewer'});for(const modelRole of ['builder','reviewer'])await c.record({type:'usage',attemptId:a.id,modelRole,usage:{...emptyUsage(),turns:1,totalTokens:10,costUsd:0.01}});await c.record({type:'steer-requested',attemptId:a.id,steeringId:'s1',message:'<script>bad</script>'});throw Error('crash');},async verify(){throw Error('unused');},async verifyIntegration(){throw Error('unused');},async cleanup(){}},c),/crash/u);
  await c.close();
  const teams=await readTeams(project);assert.equal(teams.length,1);assert.equal(teams[0]!.live,false);assert.equal(teams[0]!.status,'interrupted');assert.equal(teams[0]!.costUsd,0.02);assert.equal(teams[0]!.attempts[0]!.phase,'reviewing');assert.deepEqual(teams[0]!.tasks[1]!.waitingFor,['api']);assert.equal(teams[0]!.steering[0]!.state,'requested');
  assert.match(formatTeams(teams),/reviewer/u);await view(project,[]);const html=await readFile(path.join(root,'project-harness/view.html'),'utf8');assert.match(html,/Teams/u);assert.match(html,/&lt;script&gt;/u);assert.doesNotMatch(html,/<script>bad/u);
  const resumedControl=await TeamControl.start(dir);try{const resumed=await resumeTeam(project,dir,{async execute(){throw Error('spent budget must not reset');},async verify(){throw Error('unused');},async verifyIntegration(){throw Error('unused');},async cleanup(){}},resumedControl);assert.equal(resumed.status,'stopped');assert.match(resumed.reason??'',/cost limit/u);}finally{await resumedControl.close();}
 }finally{await rm(root,{recursive:true,force:true});}
});
