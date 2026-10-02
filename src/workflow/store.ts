import {validateCheckLimits} from '../acceptance/budget.ts';
import path from 'node:path';import {mkdir} from 'node:fs/promises';
import {harnessDirectory} from '../record/record.ts';
import {readArtifact,atomicWrite} from '../planning/store.ts';
import type {ContinueState} from './controller.ts';
import {OperatorError} from '../verbs/io.ts';
export function parseContinuation(raw:unknown):ContinueState{
 const s=raw as ContinueState;
 if(!s||s.version!==1||typeof s.task!=='string'||!s.task.trim()||s.task.length>500||s.task.includes('\0')||!['running','paused','attention','approval','complete'].includes(s.status)||typeof s.message!=='string'||s.message.length>10000||typeof s.updated!=='string'||!Number.isFinite(Date.parse(s.updated))||!Number.isSafeInteger(s.attempts)||s.attempts<0||!Number.isSafeInteger(s.maxBuilds)||s.maxBuilds<1||s.maxBuilds>10||s.attempts>s.maxBuilds||![0,1].includes(s.recoveries)||!Array.isArray(s.events)||s.events.length>30||s.events.some(e=>!e||typeof e.at!=='string'||typeof e.stage!=='string'||typeof e.message!=='string'||e.message.length>4000))throw new OperatorError('Invalid continuation state. Inspect the retained state before resuming.');
 if(s.checkLimits)validateCheckLimits(s.checkLimits);
 for(const n of [s.checkRequestBase,s.checkDeadline])if(n!==undefined&&(!Number.isSafeInteger(n)||n<0))throw new OperatorError('Invalid saved continuation allowance.');
 return s;
}
export async function readContinuation(project:string):Promise<ContinueState|undefined>{const raw=await readArtifact(harnessDirectory(project),'continuation.json',1024*1024);return raw?parseContinuation(JSON.parse(raw)):undefined;}
export async function saveContinuation(project:string,state:ContinueState):Promise<void>{parseContinuation(state);await mkdir(harnessDirectory(project),{recursive:true,mode:0o700});await atomicWrite(path.join(harnessDirectory(project),'continuation.json'),JSON.stringify(state,null,2)+'\n');}
