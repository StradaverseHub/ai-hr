/** Protected import-worker companion queue. One source slice and one employment transaction per tick.
 * Physical owner authentication and canonical admission retain activation/cutover authority. */
import type postgres from 'postgres';
import {sql} from 'drizzle-orm';
import {createDb,type SessionContext} from '../db/client';
import {resolveEntitlementsInTenantTx} from './entitlements';
import {admitProbationPersonnelTx} from './probation';

type OwnerConnection=ReturnType<typeof createDb>;
export async function runProbationReconciliationTick(owner:postgres.Sql,connection:OwnerConnection):Promise<boolean>{
 const scheduled=await owner.begin(async tx=>{
  const[r]=await tx<{worked:boolean}[]>`select app.probation_reconciliation_schedule_tick() as worked`;
  return r?.worked===true;
 });
 // Discovery reads only owner-protected queue metadata, no HR facts or captured human privilege.
 const[tenant]=await owner<{tenant_id:string}[]>`select i.tenant_id from probation_reconciliation_intent i join tenant t on t.id=i.tenant_id where t.status in('active','trial') and i.retry_on<=now() order by i.retry_on,i.tenant_id,i.employment_id limit 1`;
 if(!tenant)return scheduled;
 const base:SessionContext={tenantId:tenant.tenant_id,roles:[],grants:[]};
 const entitlements=await owner.begin(tx=>resolveEntitlementsInTenantTx(async(query,params)=>[...await tx.unsafe(query,params as postgres.ParameterOrJSON<never>[])],base.tenantId));
 const ctx={...base,entitlements};
 return connection.withTenant(ctx,async tx=>{
  const[proof]=await tx.execute<{allowed:boolean}>(sql`select app.probation_storage_runner() as allowed`);
  if(!proof?.allowed)throw new Error('Physical no-login Probation owner required.');
  // Canonical lock order, then schedule -> employment -> intent. Personnel writes hold employment
  // before their AFTER-trigger intent, while the scheduler holds schedule before its queue upsert.
  // Never wait on an employment held by a Personnel request while retaining either queue lock.
  await tx.execute(sql`select app.probation_write_lock()`);
  const[schedule]=await tx.execute(sql`select tenant_id from probation_reconciliation_schedule where tenant_id=${ctx.tenantId}::uuid for update skip locked`);
  if(!schedule)return scheduled;
  const[next]=await tx.execute<{employment_id:string}>(sql`select employment_id from probation_reconciliation_intent where tenant_id=${ctx.tenantId}::uuid and retry_on<=now() order by retry_on,employment_id limit 1`);
  if(!next)return scheduled;
  const[subject]=await tx.execute(sql`select id from employment where tenant_id=${ctx.tenantId}::uuid and id=${next.employment_id}::uuid for update skip locked`);
  if(!subject)return scheduled;
  const[intent]=await tx.execute<{employment_id:string;revision:string}>(sql`select employment_id,revision::text from probation_reconciliation_intent where tenant_id=${ctx.tenantId}::uuid and employment_id=${next.employment_id}::uuid and retry_on<=now() for update skip locked`);
  if(!intent)return scheduled;
  const[candidate]=await tx.execute<{reasons:string[]}>(sql`select reasons from app.probation_reconciliation_population(null,${intent.employment_id}::uuid)`);
  let failure=false;
  if(candidate&&candidate.reasons.length===0){
   // Savepoint preserves the original guarded refusal without poisoning the queue checkpoint.
   // SQL guard failures are never shown verbatim to an employee.
   try{await tx.transaction(async scope=>{
    const[reviewed]=await scope.execute<{batchId:string;entryId:string;record:unknown;parts:unknown;settingsId:string;formId:string;routeId:string}>(sql`
     select b.id::text as "batchId",i->>'entryId' as "entryId",(i->'record')||jsonb_build_object('milestones',i->'milestones','cutoverBatchId',b.id) as record,
      i->'record'->'parts' as parts,i->>'settingsId' as "settingsId",i->>'formId' as "formId",i->>'routeId' as "routeId"
     from probation_cutover b join probation_activation a on a.tenant_id=b.tenant_id and a.company_id=b.company_id and a.enabled and a.dry_run_digest=b.digest
     cross join lateral jsonb_array_elements(coalesce(b.data->'imports','[]')) i
     where b.tenant_id=${ctx.tenantId}::uuid and b.approved_by is not null and b.applied_at is not null and b.data->>'planComplete'='true' and i->>'employmentId'=${intent.employment_id}
     order by b.applied_at desc,b.id limit 1`);
    if(reviewed){
     const[admitted]=await scope.execute<{id:string}>(sql`select app.probation_admit(${JSON.stringify(reviewed.record)}::jsonb,${JSON.stringify(reviewed.parts)}::jsonb,${reviewed.settingsId}::uuid,${reviewed.formId}::uuid,${reviewed.routeId}::uuid,'Personnel reconciliation: exact approved existing-probation cutover') as id`);
     await scope.execute(sql`select app.probation_apply_intake_stage(${reviewed.batchId}::uuid,${reviewed.entryId}::uuid,${admitted.id}::uuid)`);
    }else await admitProbationPersonnelTx(scope,ctx,intent.employment_id,'Personnel reconciliation: eligible Probation employment');
   });}
   catch{failure=true;}
  }
  await tx.execute(sql`update probation_reconciliation_intent set checked_at=now(),retry_on=now()+interval '15 minutes',failure=${failure} where tenant_id=${ctx.tenantId}::uuid and employment_id=${intent.employment_id}::uuid and revision=${intent.revision}::bigint`);
  // A successful full scan only counts once every queued check has committed, and no unexpected
  // admission failed in that pass. Explicit setup/cutover holds are successful, visible checks.
  await tx.execute(sql`update probation_reconciliation_schedule s set last_success_at=now(),started_at=null where s.tenant_id=${ctx.tenantId}::uuid and s.cursor_id is null and s.next_check_at>now() and s.started_at is not null and not exists(select 1 from probation_reconciliation_intent i where i.tenant_id=s.tenant_id and(i.checked_at is null or i.checked_at<i.requested_at or i.failure))`);
  return true;
 });
}
