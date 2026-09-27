import {parseJourney,actionRequest,assessJourney,type Journey} from '../../desktop/schema.ts';
export function parseMacJourney(raw:unknown):Journey {
 const journey=parseJourney(raw);
 if(journey.timeoutSeconds<60)throw Error('macOS GUI checks need 60–300 seconds, including VM startup.');
 if(journey.steps.filter(s=>s.action==='screenshot').length>3)throw Error('Keep macOS GUI journeys to at most three screenshots.');
 return journey;
}
export const guiActions=actionRequest;
export const assessMacJourney=assessJourney;
