import assert from 'node:assert/strict';
import test from 'node:test';
import { parseJobSpec, validateCheckpoint } from '../src/jobs/schema.ts';
const spec = {version:1,title:'Count',command:['node','count.js'],outputs:['result.json'],checkpoint:{protocol:'json-step@1',total:10},limits:{timeoutSeconds:60,totalSeconds:120,maxAttempts:2}};
test('job declarations are bounded and cannot grant permissions', () => {
 assert.deepEqual(parseJobSpec(spec),spec);
 for(const override of [{network:'bridge'},{command:[]},{outputs:['../x']},{outputs:['result.json','result.json']},{checkpoint:{protocol:'pickle',total:10}},{limits:{timeoutSeconds:0,totalSeconds:120,maxAttempts:2}},{limits:{timeoutSeconds:60,totalSeconds:30,maxAttempts:2}}]) assert.throws(()=>parseJobSpec({...spec,...override}));
});
test('checkpoint protocol binds identities and progress before interpreting payload', () => {
 const checkpoint={version:1,protocol:'json-step@1',identity:'a'.repeat(64),completed:4,total:10,payload:{count:4}};
 assert.equal(validateCheckpoint(Buffer.from(JSON.stringify(checkpoint)),spec.checkpoint,'a'.repeat(64),3).completed,4);
 for(const override of [{identity:'b'.repeat(64)},{version:2},{completed:2},{completed:11},{total:11},{payload:null}]) assert.throws(()=>validateCheckpoint(Buffer.from(JSON.stringify({...checkpoint,...override})),spec.checkpoint,'a'.repeat(64),3));
});
