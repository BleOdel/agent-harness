import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createTeam, driveTeam, resumeTeam, type Worker } from "../src/team/controller.ts";
import { parseTeamPlan } from "../src/team/schema.ts";
import { TeamControl, sendControl } from "../src/team/control.ts";
import { applyTeam } from "../src/team/apply.ts";
import { copySource, captureCandidate } from "../src/workspace/candidate.ts";

test("abort during builder or integration stops dispatch, drains cleanup and never permits application", async () => {
  for (const phase of ["building","integration"]) {
    const root=await mkdtemp(path.join(os.tmpdir(),"team-abort-")),project=path.join(root,"project");await mkdir(project);
    const tasks=["one","two"].map((id,i)=>({id,title:id,criteria:["works"],priority:"must" as const,status:"todo" as const,dependsOn:i?["one"]:[]}));await writeFile(path.join(project,"features.json"),JSON.stringify(tasks));
    const dir=await createTeam(project,parseTeamPlan({version:1,roles:[{id:"builder",instructions:"build",skills:[]}],skills:[]},tasks),root,{maxAttempts:1,maxDispatches:4,maxMs:60000,maxCostUsd:1});
    const control=await TeamControl.start(dir);const cleaned:string[]=[];let calls=0;
    const worker:Worker={
      async execute(a){calls++;if(phase==='building')await sendControl(dir,{type:'abort'});const work=path.join(a.directory,'work');await copySource(a.baseline.directory,work);await writeFile(path.join(work,'one.txt'),'built');return {outcome:'submitted',candidate:await captureCandidate(a.baseline,work,path.join(a.directory,'candidate')),usage:{tokens:1,costUsd:0,complete:true},observedReads:[],workflowEvidence:[]};},
      async verify(){return {passed:true,gates:['passes'],review:'pass'};},
      async verifyIntegration(){await sendControl(dir,{type:'abort'});return {passed:true,gates:['passes'],review:'pass'};},
      async cleanup(a){cleaned.push(a.id);},
    };
    try {
      const state=await driveTeam(dir,worker,control);assert.equal(state.status,'aborted');assert.equal(calls,1);assert.ok(cleaned.length);assert.deepEqual(state.integrated,[]);
      await assert.rejects(readFile(path.join(project,'one.txt')),{code:'ENOENT'});await assert.rejects(applyTeam(project,dir),/abort/iu);
      await assert.rejects(resumeTeam(project,dir,worker),/abort/iu);
    }finally{await control.close();await rm(root,{recursive:true,force:true});}
  }
});
