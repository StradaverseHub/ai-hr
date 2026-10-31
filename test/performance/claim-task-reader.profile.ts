/** Paired populated native queue comparison; no HTTP capacity or release claim. */
import {randomUUID,createHash} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {and,desc,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import type {SessionContext} from '../../db/client';
import {withClaimsTenant as withTenant} from '../../core/module-gate';
import * as s from '../../db/schema';
import type {AssignedApprovalMetadata} from '../../lib/assigned-work';
import {pendingClaimTaskMetadata,actionablePendingClaimIds,createClaimType} from '../../packs/claims/service';
import {assertAssignedWorkPrincipalTx,filterDelegationOrgScopeTx} from '../../core/approvals';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);
// Exact original reader from8f14ac409; names, native RLS and the fresh decision recheck retained.
async function previous(ctx:SessionContext,companyIds?:string[]):Promise<AssignedApprovalMetadata[]>{
 const candidates=await withTenant(ctx,async tx=>{
  await assertAssignedWorkPrincipalTx(tx,ctx);
  const rows=await tx.select({id:s.claimRequest.id,employmentId:s.claimRequest.employmentId,personId:sql<string>`approval_subject.person_id`,
   employee:sql<string>`approval_subject.employee`,createdAt:s.claimRequest.createdAt}).from(s.claimRequest)
   .innerJoin(sql`LATERAL app.delegated_approval_subject(${s.claimRequest.employmentId},'claims','claims.claim') AS approval_subject`,sql`true`)
   .where(and(eq(s.claimRequest.tenantId,ctx.tenantId),eq(s.claimRequest.status,'pending'),sql`NOT app.is_self_person(approval_subject.person_id)`,
    companyIds===undefined?undefined:sql`approval_subject.company_id = ANY(ARRAY[${sql.join(companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])`))
   .orderBy(desc(s.claimRequest.createdAt),s.claimRequest.id);
  return filterDelegationOrgScopeTx(tx,ctx,rows,row=>row.employmentId);
 });
 const allowed=new Set(await actionablePendingClaimIds(ctx,candidates.map(row=>row.id)));
 return candidates.filter(row=>allowed.has(row.id));
}

it('compares identical populated queues for native HR, manager and employee principals',async()=>{
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
  from unnest(${users.slice(2).map(u=>u.employmentId)}::uuid[])e(id)cross join generate_series(1,2000)n`;
 for(const table of ['person','employment','app_user','role_assignment','claim_request','reporting_line'])await owner.client.unsafe('analyze '+table);
 const context=(u:typeof users[number]):SessionContext=>({...base,userId:u.id,personId:u.personId,roles:[u.role],grants:[{role:u.role,companyId:u.role==='hr_admin'?null:b.companyId}]});
 const digest=(rows:AssignedApprovalMetadata[])=>createHash('sha256').update(JSON.stringify(rows.map(row=>Object.fromEntries(Object.entries(row).sort(([a],[b])=>a.localeCompare(b)))))).digest('hex');
 const expected=new Map<string,string>(),phases:Record<string,unknown>={};
 for(const phase of ['previous-before','current','previous-after']){
  const read=phase==='current'?pendingClaimTaskMetadata:previous,measurements=[];
  for(const u of users.slice(0,3)){
   const ctx=context(u);await expect(read({...ctx,personId:randomUUID()})).rejects.toThrow();
   const times=[];
   for(let i=0;i<3;i++){
    const start=performance.now(),rows=await read(ctx);times.push(performance.now()-start);
    expect(rows).toHaveLength(u.role==='hr_admin'?100000:u.role==='manager'?20000:0);
    const key=u.role;if(!expected.has(key))expected.set(key,digest(rows));else expect(digest(rows)).toBe(expected.get(key));
   }
   measurements.push({role:u.role,reads:3,elapsedMs:times,orderedMetadataIdentical:true});
  }
  phases[phase]=measurements;writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'claim-task-reader.json'),JSON.stringify({kind:'NATIVE_POPULATED_CLAIM_METADATA_COMPARISON',releaseEligible:false,claims:100000,principals:3,phases},null,2));
 }
},300000);
