import {OperatorError} from '../verbs/io.ts';
/** No complete usable response: request spend counts, but this is not a check defect. */
export class CheckRequestInterrupted extends OperatorError {
 readonly kind:'provider'|'timeout'|'output-limit';
 constructor(kind:CheckRequestInterrupted['kind'],message:string){super(message,'The request spend is recorded. Saved code and completed reviews are retained; no check-defect attempt was consumed. Resume the same preparation when the provider is available.');this.kind=kind;}
}
