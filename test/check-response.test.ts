import test from 'node:test';import assert from 'node:assert/strict';import {CheckResponse} from '../src/acceptance/response.ts';
test('check response reads final text and counts turn usage once, including failed calls',()=>{
 const response=new CheckResponse();const message={role:'assistant',content:[{type:'text',text:'{"verdict":"pass"}'}],usage:{totalTokens:25,cost:{total:0.01}},model:'test'};
 const lines=[{type:'message_end',message},{type:'turn_end',message},{type:'agent_end',messages:[message]}].map(e=>JSON.stringify(e)).join('\n');
 response.push(lines.slice(0,20));response.push(lines.slice(20));response.finish();
 assert.equal(response.text,'{"verdict":"pass"}');assert.equal(response.usage.totalTokens,25);assert.equal(response.usage.costUsd,0.01);assert.equal(response.complete,true);
});
test('missing usage is unknown rather than zero; tool messages cannot replace final JSON',()=>{
 const response=new CheckResponse();response.push(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'{}'}]}})+'\n');
 response.push(JSON.stringify({type:'turn_end',message:{role:'assistant',content:[]}})+'\n');response.push(JSON.stringify({type:'message_end',message:{role:'toolResult',content:[{type:'text',text:'not JSON'}]}}));response.finish();
 assert.equal(response.text,'{}');assert.equal(response.complete,false);
});
test('an interrupted stream retains reported usage but cannot claim complete reporting',()=>{
 const response=new CheckResponse(),message={role:'assistant',content:[{type:'text',text:'{}'}],usage:{totalTokens:10,cost:{total:0.001}}};
 response.push(JSON.stringify({type:'turn_end',message})+'\n');response.finish();assert.equal(response.usage.totalTokens,10);assert.equal(response.complete,false);
});
