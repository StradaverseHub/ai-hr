/** Credential lockout shares the caller's subject advisory lock. Admission failures commit counters. */
import type {Credential} from './credential';
import {readRecord,writeRecord,deleteRecord,type AuthSql} from './record-store';
import {effectivePasswordPolicy} from './password-policy';
export type LoginFailures={attempts:number;lockedAt:number|null};
export const loginFailuresKey=(subject:string)=>`login-failures:${subject}`;
export async function admitPasswordAttempt(tx:AuthSql,c:Credential,matched:boolean,now=Date.now()){
 const policy=await effectivePasswordPolicy(tx,c.tenantId),key=loginFailuresKey(c.subject);
 const requirements=policy.requirements;
 if(!requirements?.lockoutEnabled){if(matched)await deleteRecord(tx,key);return matched;}
 let state=await readRecord<LoginFailures>(tx,key,true)??{attempts:0,lockedAt:null};
 if(state.lockedAt!==null){
  if(!requirements.autoUnlock||now<state.lockedAt+requirements.unlockMinutes*60_000)return false;
  state={attempts:0,lockedAt:null};
 }
 if(matched){await deleteRecord(tx,key);return true;}
 state.attempts++;if(state.attempts>=requirements.failedAttempts)state.lockedAt=now;
 await writeRecord(tx,key,state,c.subject);return false;
}
