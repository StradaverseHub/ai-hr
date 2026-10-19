/** Personnel owns this deliberate classification; it changes no employment/financial eligibility. */
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {employment} from '../db/schema';
import {actorOf,appendEvent} from '../db/events';
import {isAdmin} from '../lib/authz-model';
import {EMPLOYMENT_TEST_RECORD_EVENT,lockMovementImportReferenceAdmissionTx} from './movement-import-admission';
function assertHr(ctx:SessionContext){if(!isAdmin(ctx)||!ctx.userId)throw new Error('classification_not_available');}
export async function employmentTestRecord(ctx:SessionContext,employmentId:string){
 assertHr(ctx);
 return withTenant(ctx,async tx=>{
  const [row]=await tx.select({isTestRecord:employment.isTestRecord}).from(employment).where(and(eq(employment.tenantId,ctx.tenantId),eq(employment.id,employmentId),sql`app.is_admin_for(${employment.companyId})`)).limit(1);
  return row??null;
 },{readOnlySnapshot:true});
}
/** Deliberately owns its transaction: no late acquisition from a caller holding statutory/data locks. */
export async function setEmploymentTestRecord(ctx:SessionContext,p:{employmentId:string;isTestRecord:boolean}){
 assertHr(ctx);if(typeof p.isTestRecord!=='boolean'||!/^[0-9a-f-]{36}$/i.test(p.employmentId))throw new Error('classification_not_available');
 return withTenant(ctx,async tx=>{
  await tx.execute(sql`select set_config('lock_timeout','1000ms',true),set_config('statement_timeout','5000ms',true)`);
  await lockMovementImportReferenceAdmissionTx(tx,ctx.tenantId);
  const [row]=await tx.select({id:employment.id,companyId:employment.companyId,isTestRecord:employment.isTestRecord}).from(employment).where(and(eq(employment.tenantId,ctx.tenantId),eq(employment.id,p.employmentId))).limit(1).for('no key update');
  if(!row)throw new Error('classification_not_available');
  const [scope]=await tx.execute<{ok:boolean}>(sql`select app.is_admin_for(${row.companyId}::uuid) as ok`);
  if(!scope?.ok)throw new Error('classification_not_available');
  if(row.isTestRecord===p.isTestRecord)return {changed:false};
  await tx.update(employment).set({isTestRecord:p.isTestRecord}).where(eq(employment.id,row.id));
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'employment',aggregateId:row.id,eventType:EMPLOYMENT_TEST_RECORD_EVENT,actor:actorOf(ctx),subjectEmploymentId:row.id,payload:{companyId:row.companyId,before:row.isTestRecord,after:p.isTestRecord}});
  return {changed:true};
 });
}
