import {OperatorError} from '../verbs/io.ts';
/** No complete usable response: request spend counts, but this is not a check defect. */
export class CheckRequestInterrupted extends OperatorError {
 readonly kind:'provider'|'timeout'|'output-limit';
 constructor(kind:CheckRequestInterrupted['kind'],message:string){super(message,'The request spend is recorded. Saved code and completed reviews are retained; no check-defect attempt was consumed. Resume the same preparation when the provider is available.');this.kind=kind;}
}

/** Retry only recognized transport interruptions, never credential/quota failures. */
export function transientCheckFailure(error:CheckRequestInterrupted):boolean{
 if(error.kind==='timeout')return true;
 if(error.kind!=='provider'||/auth|token|quota|usage.limit|credit|billing|401|403/iu.test(error.message))return false;
 return /\b(?:429|502|503|504)\b|ECONNRESET|ETIMEDOUT|temporarily unavailable|temporarily overloaded/iu.test(error.message);
}
