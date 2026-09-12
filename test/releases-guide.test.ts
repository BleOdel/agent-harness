import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {putArtifact} from '../src/artifacts/store.ts';
import {setupRelease,reviewRelease,guideReleases} from '../src/guide/releases.ts';
import {listReleases,saveRelease} from '../src/releases/store.ts';
function dialogue(answers:string[]){const lines:string[]=[];return {lines,io:{write:(s:string)=>{lines.push(s);},ask:async(s:string)=>{lines.push(s);assert.ok(answers.length,s);return answers.shift()!;}}};}
test('release guide saves a reviewable draft, preserves declined approval and selects actions without IDs',async t=>{
 const root=await mkdtemp('/private/tmp/release-guide-'),project=root+'/app',out=root+'/out';await mkdir(project);await mkdir(out);t.after(()=>rm(root,{recursive:true,force:true}));
 await putArtifact(project,'model.json',Buffer.from('{}'),{producer:'fixture',input:'a'.repeat(64),environment:'b'.repeat(64),verification:'diagnostics-passed'});
 const setup=dialogue(['1','model','1.0.0',out]);await setupRelease(project,setup.io);const d=(await listReleases(project))[0]!;assert.equal(d.status,'draft');assert.ok(setup.lines.some(l=>l.includes(d.manifest.target)));
 await reviewRelease(project,d.id,dialogue(['n']).io);assert.equal((await listReleases(project))[0]!.status,'draft');await reviewRelease(project,d.id,dialogue(['y']).io);assert.equal((await listReleases(project))[0]!.status,'approved');
 const calls:string[][]=[],guide=dialogue(['1','3','0']);await guideReleases(project,guide.io,async(_p,args)=>{calls.push([...args]);return 0;});assert.deepEqual(calls,[['release','stage',d.id]]);
 const interrupted=(await listReleases(project))[0]!;interrupted.status='retired';await saveRelease(project,interrupted);const recovery=dialogue(['1','2','0']);
 await guideReleases(project,recovery.io,async(_p,args)=>{calls.push([...args]);return 0;});assert.deepEqual(calls.at(-1),['release','retire',d.id,'--yes']);assert.ok(recovery.lines.some(l=>l.includes('Finish interrupted reference cleanup')));
});
