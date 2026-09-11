/** Deterministic protocol fixture; never presented as a live model run. */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { PI_RPC_VERSION } from "../src/agent/rpc.ts";
export async function writeRpcFixture(pi: string, program: string): Promise<void> {
  await writeFile(path.join(pi,"package.json"),JSON.stringify({version:PI_RPC_VERSION}));
  await writeFile(path.join(pi,"dist/cli.js"), `
const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');let buffer='',goal='',streaming=false;
function execute(){let turn,answer='';const capture={log(text){const value=JSON.parse(text);if(value.type==='turn_end')turn=value.message;else if(value.type)send(value);else answer=text;}};
new Function('console','require','process',${JSON.stringify(program)})(capture,require,{...process,argv:[...process.argv,goal]});
if(goal.includes('WAIT_FOR_KILL'))return;
const message={role:'assistant',stopReason:'stop',content:[{type:'text',text:answer}],provider:'fixture',model:'fixture',usage:{totalTokens:1,cost:{total:0}},...turn};
send({type:'turn_end',message});send({type:'message_end',message});send({type:'agent_end',messages:[message]});streaming=false;send({type:'agent_settled'});}
process.stdin.on('data',data=>{buffer+=data.toString();let i;while((i=buffer.indexOf('\\n'))>=0){const c=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);const reply=data=>send({type:'response',id:c.id,command:c.type,success:true,...(data?{data}:{})});
if(c.type==='get_state')reply({isStreaming:streaming,isCompacting:false,pendingMessageCount:0});
else if(c.type==='prompt'){goal=c.message;reply();streaming=true;send({type:'agent_start'});if(goal.includes('WAIT_FOR_STEER')&&!process.argv.includes('read,grep'))require('node:fs').writeFileSync('/pi-agent/ready','yes');else execute();}
else if(c.type==='steer'){reply();send({type:'message_start',message:{role:'user',content:[{type:'text',text:c.message}]}});if(goal.includes('WAIT_FOR_STEER')){goal=goal.replace('WAIT_FOR_STEER','')+'\\n'+c.message;execute();}}
else if(c.type==='abort'){reply();/* Deliberately ignore abort; host must remove this owned container. */}
else send({type:'response',id:c.id,command:c.type,success:false,error:'unsupported'});
}});
`);
}
