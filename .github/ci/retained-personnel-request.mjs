/** Bounded synthetic retained-row fixture lane; never a release, deployment or model-evaluation authority. */
import assert from 'node:assert/strict';
export const RETAINED_PERSONNEL_FILE='test/performance/personnel-retained-million.test.ts';
export function retainedPersonnelRequest(env,files){
 const flag=env.AIHR_RETAINED_PERSONNEL_MILLION;
 assert(flag===undefined||flag===''||flag==='false'||flag==='true','Invalid retained Personnel request');
 const requested=flag==='true';
 if(!requested){assert(!files.includes(RETAINED_PERSONNEL_FILE),'Million-row fixture requires its explicit bounded lane');return false;}
 assert(files.length===1&&files[0]===RETAINED_PERSONNEL_FILE,'Retained fixture lane admits only the exact million-Personnel file');
 assert(env.AIHR_RETAINED_PERSONNEL_TYPECHECK==='true','Whole-repository typecheck required for retained fixture lane');
 assert(!env.AIHR_EVAL_MODEL,'Retained fixture lane cannot request a model or protected provider environment');
 return true;
}
