import {parseJourney,actionRequest,assessJourney,type Journey} from '../../desktop/schema.ts';
export interface AppleJourney extends Journey {entry:string;app:string;}
function relative(value:unknown,suffix:string){return typeof value==='string'&&value.length<=200&&/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u.test(value)&&value.endsWith(suffix)&&value.split('/').every(p=>p!=='.'&&p!=='..');}
export function parseAppleJourney(raw:unknown):AppleJourney {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('Expected a native app journey.');
 const {entry,app,...rest}=raw as Record<string,unknown>;
 if(!relative(entry,'.sh')||!relative(app,'.app'))throw Error('Use relative build script (.sh) and application bundle (.app) paths without traversal.');
 if(!Number.isSafeInteger(rest.timeoutSeconds)||Number(rest.timeoutSeconds)<60||Number(rest.timeoutSeconds)>600)throw Error('Native app journeys require 60–600 seconds including compilation and VM startup.');
 const journey=parseJourney({...rest,timeoutSeconds:Math.min(300,Number(rest.timeoutSeconds))});
 if(journey.steps.filter(s=>s.action==='screenshot').length>3)throw Error('Use at most three screenshots.');
 for(const step of journey.steps)if('selector' in step&&!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/u.test(step.selector))throw Error('Use an accessibility identifier, not a CSS selector or screen coordinates.');
 return {...journey,timeoutSeconds:Number(rest.timeoutSeconds),entry:entry as string,app:app as string};
}
export function appleActions(s:AppleJourney){return {...actionRequest(s),app:'app-source/'+s.app};}
export const assessAppleJourney=assessJourney;
