/** Final assistant text and provider usage have separate event lifecycles. */
import {EventStream} from '../agent/events.ts';
export class CheckResponse {
 private pending='';private events=new EventStream();private turns=0;private missing=false;private ended=false;
 text='';get usage(){return this.events.current();}get complete(){return this.ended&&this.turns>0&&!this.missing&&!this.failure;}get failure(){return this.events.failure();}
 push(chunk:string):void{this.events.push(chunk);this.pending+=chunk;const lines=this.pending.split('\n');this.pending=lines.pop()??'';for(const line of lines)this.line(line);}
 finish():void{this.events.finish();if(this.pending.trim())this.line(this.pending);this.pending='';}
 private line(line:string):void{
  let e;try{e=JSON.parse(line);}catch{return;}
  if(e.type==='agent_start')this.ended=false;
  if(e.type==='agent_end')this.ended=true;
  if(e.type==='message_end'&&e.message?.role==='assistant'&&Array.isArray(e.message.content))this.text=e.message.content.filter((c:{type?:string;text?:unknown})=>c.type==='text'&&typeof c.text==='string').map((c:{text:string})=>c.text).join('');
  if(e.type==='turn_end'){this.turns++;const u=e.message?.usage;if(![u?.totalTokens,u?.cost?.total].every(n=>typeof n==='number'&&Number.isFinite(n)&&n>=0))this.missing=true;}
 }
}
