/**
 * Item 1859cce0 — what the employee import screen says when an upload or a progress check does not get a clear
 * answer. Four different situations, never folded into one "nothing was changed":
 *  - the request never reached the server (a thrown fetch TypeError): try again; the same preview reuses its upload
 *    operation, so a duplicate is refused rather than imported twice;
 *  - 502 / 503: the system is unavailable; check Import History before trying again;
 *  - 504 or an abort: it is taking longer than expected and may still be running;
 *  - a JSON refusal from the server: shown as returned.
 * Only a 4xx with no message (the request was refused before anything started) keeps "nothing was changed".
 */
type Translate=(key:string)=>string;
export function employeeUploadErrorMessage(outcome:{thrown:unknown}|{status:number;error?:string|null},t:Translate){
 if('thrown' in outcome){
  const abort=outcome.thrown instanceof Error&&outcome.thrown.name==='AbortError';
  return abort?t('uploadErrors.timeout'):outcome.thrown instanceof TypeError?t('uploadErrors.unreachable'):t('uploadErrors.unknown');
 }
 if(typeof outcome.error==='string'&&outcome.error)return outcome.error;
 if(outcome.status===413)return t('fileTooLarge');
 if(outcome.status===504)return t('uploadErrors.timeout');
 if(outcome.status===502||outcome.status===503)return t('uploadErrors.unavailable');
 if(outcome.status>=500)return t('uploadErrors.unknown');
 return t('employeeUploadFailed');
}
/** A progress check that failed: the import itself keeps running in the background. */
export function employeeProgressErrorMessage(outcome:{thrown:unknown}|{status:number;error?:string|null},t:(key:string)=>string){
 if('thrown' in outcome)return t('uploadErrors.progressUnreachable');
 if(typeof outcome.error==='string'&&outcome.error)return outcome.error;
 return outcome.status>=500?t('uploadErrors.progressUnreachable'):t('uploadErrors.unknown');
}
