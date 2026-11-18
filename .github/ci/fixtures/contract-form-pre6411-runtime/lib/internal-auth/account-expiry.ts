/** Caller owns the subject advisory lock. Persist one system transition per configured deadline. */
import {randomUUID} from 'node:crypto';
import {todayInKualaLumpur} from '../hr-date';
import type {Credential} from './credential';
import {readRecord,writeRecord,revokeCredentialsSessions,type AuthSql} from './record-store';
export async function observeAccountExpiry(tx:AuthSql,c:Credential){
 if(!c.enabled||!c.accountActiveUntil||c.accountActiveUntil>=todayInKualaLumpur())return false;
 if(c.accountExpiryObservedUntil===c.accountActiveUntil)return true;
 c.version=randomUUID();c.accountExpiryObservedUntil=c.accountActiveUntil;
 await revokeCredentialsSessions(tx,c.subject);
 await writeRecord(tx,`credential:${c.subject}`,c,c.subject);
 const [p]=await tx.unsafe('select app_user_id,tenant_id from app.principal_by_identity($1,$2)',[c.issuer,c.subject]);
 if(p?.tenant_id===c.tenantId)await tx.unsafe("select app.append_auth_event($1::uuid,'app-user',$2::uuid,'app-user.account-expired','system',NULL,$3::jsonb)",[c.tenantId,p.app_user_id,JSON.stringify({activeUntil:c.accountActiveUntil})]);
 return true;
}
export async function observeStoredAccountExpiry(tx:AuthSql,subject:string){
 const current=await readRecord<Credential>(tx,`credential:${subject}`,true);
 return current?observeAccountExpiry(tx,current):false;
}
