// Fixed offline job supervisor. Diagnostics and payloads remain untrusted project output.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
const context=JSON.parse(fs.readFileSync('/harness-input/.harness-job-context.json','utf8'));
// Bound container lifetime even if detached descendants keep inherited pipes open.
setTimeout(()=>process.exit(124),(context.timeoutSeconds+60)*1000);
await fs.promises.cp('/harness-input','/work',{recursive:true,dereference:false});
fs.mkdirSync('/work/.harness-output',{recursive:true});
const status={version:1,phase:'running',code:null,outputLimited:false,timedOut:false,stdout:'',stderr:''};
const publish=()=>{fs.writeFileSync('/work/.harness-job-status.tmp',JSON.stringify(status));fs.renameSync('/work/.harness-job-status.tmp','/work/.harness-job-status.json');};
let size=0;
const child=spawn(context.command[0],context.command.slice(1),{cwd:'/work',detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,HARNESS_JOB_IDENTITY:context.identity,HARNESS_JOB_TOTAL:String(context.total??0),HARNESS_JOB_OUTPUT:'/work/.harness-output',HARNESS_JOB_RESUME:context.resume?'/work/.harness-output/resume.json':''}});
const stop=()=>{if(!child.pid)return;try{process.kill(-child.pid,'SIGKILL');}catch(e){if(e.code!=='ESRCH')throw e;}};
const deadline=setTimeout(()=>{status.timedOut=true;stop();},context.timeoutSeconds*1000);
process.on('SIGTERM',stop);process.on('SIGINT',stop);
for(const [key,stream]of [['stdout',child.stdout],['stderr',child.stderr]]) {stream.setEncoding('utf8');stream.on('data',text=>{size+=Buffer.byteLength(text);if(size>1048576){status.outputLimited=true;stop();return;}status[key]+=text;});}
child.on('error',e=>{clearTimeout(deadline);status.phase='finished';status.stderr+=e.message;publish();setTimeout(()=>process.exit(1),60000);});
child.on('close',code=>{clearTimeout(deadline);stop();status.phase='finished';status.code=code;publish();setTimeout(()=>process.exit(0),60000);});
publish();setInterval(()=>{},1000);
