import {sql} from 'drizzle-orm';
import type {Tx,SessionContext} from '../db/client';
import type {AutomationRichEmailBody} from '../lib/automation-email-content';
import {internalConfig} from '../lib/internal-auth/config';
import {signAutomationEmailAsset} from '../lib/automation-email-asset-proof';
/** Called only by the deterministic Probation executor, after its native recipient owner resolves To/CC. */
export async function prepareProbationEmailAssetSource(tx:Tx,ctx:SessionContext,input:{subjectId:string;key:string;to:readonly string[];cc:readonly string[];subject:string;body:string;richBody:AutomationRichEmailBody}):Promise<AutomationRichEmailBody|null>{
 const [principal]=await tx.execute<{ready:boolean;tenantId:string;userId:string|null;personId:string|null;transactionId:string}>(sql`
  select app.automation_email_asset_runtime_ready() as ready,app.current_tenant_id()::text as "tenantId",app.current_user_id()::text as "userId",
  (select person_id::text from public.app_user where tenant_id=app.current_tenant_id() and id=app.current_user_id()) as "personId",txid_current()::text as "transactionId"`);
 if(!principal?.ready)return null;
 if(principal.tenantId!==ctx.tenantId||principal.userId!==(ctx.userId??null))throw new Error('Shared email runtime principal changed.');
 let master:string;try{master=internalConfig().key;}catch{return null;}
 const {sourceProof:_previous,...richBody}=input.richBody;
 const shape={module:'probation',subjectId:input.subjectId,key:input.key,subject:input.subject.slice(0,500),body:input.body.slice(0,20000),richBody};
 const [row]=await tx.execute<{digest:string}>(sql`select encode(sha256(convert_to(${JSON.stringify(shape)}::jsonb::text,'UTF8')),'hex') as digest`);
 const proof=signAutomationEmailAsset({tenantId:principal.tenantId,userId:principal.userId,personId:principal.personId,transactionId:principal.transactionId,module:'probation',subjectId:input.subjectId,key:input.key,digest:row.digest,to:input.to,cc:input.cc},master);
 return {...richBody,sourceProof:proof};
}
