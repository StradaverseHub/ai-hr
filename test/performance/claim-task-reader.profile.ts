/** Paired populated native queue comparison; no HTTP capacity or release claim. */
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import type {SessionContext} from '../../db/client';
import {withClaimsTenant as withTenant} from '../../core/module-gate';
import * as s from '../../db/schema';
import {createClaimType} from '../../packs/claims/service';
import {assertAssignedWorkPrincipalTx,filterDelegationOrgScopeTx} from '../../core/approvals';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);
// Exact candidate-subject query from the current private application reader; no full-header transfer.
async function original(ctx:SessionContext){return withTenant(ctx,async tx=>{
 await assertAssignedWorkPrincipalTx(tx,ctx);
 const pending=tx.selectDistinct({employmentId:s.claimRequest.employmentId}).from(s.claimRequest)
  .where(and(eq(s.claimRequest.tenantId,ctx.tenantId),eq(s.claimRequest.status,'pending'))).as('pending_claim_subjects');
 const rows=await tx.select({employmentId:pending.employmentId,personId:sql<string>`approval_subject.person_id`,employee:sql<string>`approval_subject.employee`}).from(pending)
  .innerJoin(sql`LATERAL app.delegated_approval_subject(${pending.employmentId},'claims','claims.claim') AS approval_subject`,sql`true`)
  .where(sql`NOT app.is_self_person(approval_subject.person_id)`);
 return filterDelegationOrgScopeTx(tx,ctx,rows,row=>row.employmentId);
});}
// Prototype only: discover the exact native policy subjects, then test pending existence through real RLS.
// The delegated header owner and organization filter are unchanged; no row or permission cache exists.
async function indexed(ctx:SessionContext){return withTenant(ctx,async tx=>{
 await assertAssignedWorkPrincipalTx(tx,ctx);
 const rows=await tx.execute<{employmentId:string;personId:string;employee:string}>(sql`
  with candidate_subjects as materialized (
   select unnest(app.visible_employment_ids()) as employment_id
   union select unnest(app.delegated_subject_ids('claims','claims.claim')) as employment_id
  ) select c.employment_id as "employmentId",approval_subject.person_id as "personId",approval_subject.employee
  from candidate_subjects c
  inner join lateral app.delegated_approval_subject(c.employment_id,'claims','claims.claim') as approval_subject on true
  where not app.is_self_person(approval_subject.person_id)
   and exists(select 1 from claim_request q where q.tenant_id=${ctx.tenantId}::uuid
    and q.employment_id=c.employment_id and q.status='pending')`);
 return filterDelegationOrgScopeTx(tx,ctx,Array.from(rows),row=>row.employmentId);
});}

it('compares exact native pending subjects with one million retained Claims',async()=>{
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'claims','active');const base=adminCtx(b);
 const type=await createClaimType(base,{code:'PERF_META',name:'Fictional paired metadata',requiresReceipt:false,defaultTaxable:false});
 const users=Array.from({length:52},(_,i)=>({id:randomUUID(),personId:randomUUID(),employmentId:randomUUID(),role:i===0?'hr_admin' as const:i===1?'manager' as const:'employee' as const}));
 await owner.db.insert(s.person).values(users.map((u,i)=>({id:u.personId,tenantId:b.tenantId,fullName:'Fictional metadata subject '+i,primaryEmail:u.id+'@example.invalid'})));
 await owner.db.insert(s.employment).values(users.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:b.companyId,hiredOn:'2020-01-01'})));
 await owner.db.insert(s.appUser).values(users.map(u=>({id:u.id,tenantId:b.tenantId,personId:u.personId,workosUserId:'metadata_'+u.id})));
 await owner.db.insert(s.roleAssignment).values(users.map(u=>({tenantId:b.tenantId,appUserId:u.id,role:u.role,companyId:u.role==='hr_admin'?null:b.companyId})));
 await owner.db.insert(s.reportingLine).values(users.slice(2,12).map(u=>({tenantId:b.tenantId,managerEmploymentId:users[1].employmentId,subordinateEmploymentId:u.employmentId,lineType:'administrative' as const,validFrom:'2020-01-01'})));
 await owner.client`insert into claim_request(tenant_id,employment_id,claim_type_id,amount,incurred_on,status,created_at)
  select ${b.tenantId}::uuid,e.id,${type.id}::uuid,1,current_date,'pending',now()-n*interval '1 minute'
  from unnest(${users.slice(2).map(u=>u.employmentId)}::uuid[])e(id)cross join generate_series(1,20000)n`;
 for(const table of ['person','employment','app_user','role_assignment','claim_request','reporting_line'])await owner.client.unsafe('analyze '+table);
 const context=(u:typeof users[number]):SessionContext=>({...base,userId:u.id,personId:u.personId,roles:[u.role],grants:[{role:u.role,companyId:u.role==='hr_admin'?null:b.companyId}]});
 const digest=(rows:Awaited<ReturnType<typeof original>>)=>createHash('sha256').update(JSON.stringify(rows.slice().sort((a,b)=>a.employmentId.localeCompare(b.employmentId)))).digest('hex');
 const expected=new Map<string,string>(),phases:Record<string,unknown>={};
 for(const phase of ['original-before','indexed-exists','original-restored']){
  const read=phase==='indexed-exists'?indexed:original,measurements=[];
  for(const u of users.slice(0,3)){
   const ctx=context(u);await expect(read({...ctx,personId:randomUUID()})).rejects.toThrow();
   const times=[];
   for(let i=0;i<5;i++){
    const start=performance.now(),rows=await read(ctx);times.push(performance.now()-start);
    expect(rows).toHaveLength(u.role==='hr_admin'?50:u.role==='manager'?10:0);
    if(!expected.has(u.role))expected.set(u.role,digest(rows));else expect(digest(rows)).toBe(expected.get(u.role));
   }
   measurements.push({role:u.role,reads:5,elapsedMs:times,exactNativeSubjects:true});
  }
  phases[phase]=measurements;writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'claim-task-reader.json'),JSON.stringify({kind:'NATIVE_PENDING_CLAIM_SUBJECT_QUERY_COMPARISON',releaseEligible:false,claims:1000000,principals:3,phases},null,2));
 }
},300000);
