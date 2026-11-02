/** Review-task email custody from current entitlements on the maintenance connection. */
import {sql} from 'drizzle-orm';
import type {Tx} from '../../../db/client';
import {isModuleEnabled,resolveEntitlementsTx} from '../../../core/entitlements';
import {assertNotificationSweepConnection} from '../../../core/notice-projection';

export async function enrollOnehrReviewTaskEmailTx(tx:Tx,eventId:string):Promise<string[]>{
 // This is the real pre-downgrade maintenance connection, never an APP role/GUC claim.
 await assertNotificationSweepConnection(tx);
 await tx.execute(sql`select app.access_workforce_write_lock()`);
 const [scope]=await tx.execute<{tenant_id:string}>(sql`select app.current_tenant_id() as tenant_id`);
 if(!scope?.tenant_id)throw Error('OneHR worker tenant unavailable.');
 const entitlements=await resolveEntitlementsTx(tx,scope.tenant_id),ctx={tenantId:scope.tenant_id,entitlements};
 const candidates=await tx.execute<{recipient_id:string;review_company_id:string;recipient_company_id:string}>(sql`select * from app.financial_onehr_task_email_candidates(${eventId}::uuid)`);
 const sealed:string[]=[];
 for(const candidate of candidates){
  if(!isModuleEnabled(ctx,'performance',candidate.review_company_id)||!isModuleEnabled(ctx,'notifications',candidate.recipient_company_id))continue;
  const [result]=await tx.execute<{sealed:boolean}>(sql`select app.financial_onehr_task_email_enroll(${eventId}::uuid,${candidate.recipient_id}::uuid,${JSON.stringify(entitlements)}::jsonb) as sealed`);
  if(result?.sealed)sealed.push(candidate.recipient_id);
 }
 return sealed.sort();
}
