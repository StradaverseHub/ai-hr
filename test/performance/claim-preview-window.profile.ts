/** Isolated bounded-preview SQL experiment; no application change or capacity claim. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {and,desc,eq,inArray,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import type {SessionContext,Tx} from '../../db/client';
import {withClaimsTenant as withTenant} from '../../core/module-gate';
import * as s from '../../db/schema';
import {pendingClaimTaskSummary,createClaimType} from '../../packs/claims/service';
import {assertAssignedWorkPrincipalTx,filterDelegationOrgScopeTx,decisionEmploymentAuthorityTx} from '../../core/approvals';
import {scopeOf} from '../../lib/delegation-scope';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);
// The exact current delegated subject projection is shared by both logical paths.
async function pendingClaimSubjectsTx(tx:Tx,ctx:SessionContext,companyIds:string[]|undefined){
  await assertAssignedWorkPrincipalTx(tx,ctx);
  if(companyIds?.length===0)return [];
  // Resolve the delegated subject once per distinct pending employment, rather than once per
  // historical request. Keep the delegated owner: ordinary employment RLS can hide a valid delegate.
  const pendingSubjects=tx.selectDistinct({employmentId:s.claimRequest.employmentId}).from(s.claimRequest)
   .where(and(eq(s.claimRequest.tenantId,ctx.tenantId),eq(s.claimRequest.status,'pending'))).as('pending_claim_subjects');
  const subjects=await tx.select({employmentId:pendingSubjects.employmentId,personId:sql<string>`approval_subject.person_id`,
   employee:sql<string>`approval_subject.employee`}).from(pendingSubjects)
   .innerJoin(sql`LATERAL app.delegated_approval_subject(${pendingSubjects.employmentId},'claims','claims.claim') AS approval_subject`,sql`true`)
   .where(and(sql`NOT app.is_self_person(approval_subject.person_id)`,
    companyIds===undefined?undefined:sql`approval_subject.company_id = ANY(ARRAY[${sql.join(companyIds.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])`));
  return filterDelegationOrgScopeTx(tx,ctx,subjects,row=>row.employmentId);
}

async function experimental(ctx:SessionContext){
 return withTenant(ctx,async tx=>{
  await tx.execute(sql`SET LOCAL jit = off`);
  const subjects=await pendingClaimSubjectsTx(tx,ctx,undefined);
  const {allowed}=await decisionEmploymentAuthorityTx(tx,ctx,subjects.map(row=>row.employmentId),scopeOf('claims.claim'));
  if(!allowed.size)return {items:[],total:0};
  const byEmployment=new Map(subjects.filter(row=>allowed.has(row.employmentId)).map(row=>[row.employmentId,row]));
  // Each employment contributes at most25 to a global top25. All native request RLS remains active.
  const heads=tx.select({id:s.claimRequest.id,employmentId:s.claimRequest.employmentId,createdAt:s.claimRequest.createdAt})
   .from(s.claimRequest).where(and(eq(s.claimRequest.tenantId,ctx.tenantId),eq(s.claimRequest.status,'pending'),
    eq(s.claimRequest.employmentId,sql`task_subject.employment_id`))).orderBy(desc(s.claimRequest.createdAt),s.claimRequest.id).limit(25).as('preview_headers');
  const rows=await tx.select({id:heads.id,employmentId:heads.employmentId,createdAt:heads.createdAt})
   .from(sql`(VALUES ${sql.join([...allowed].map(id=>sql`(${id}::uuid)`),sql`, `)}) AS task_subject(employment_id)`)
   .innerJoinLateral(heads,sql`true`).orderBy(desc(heads.createdAt),heads.id).limit(25);
  const [count]=await tx.select({total:sql<number>`count(*)::int`}).from(s.claimRequest)
   .where(and(eq(s.claimRequest.tenantId,ctx.tenantId),eq(s.claimRequest.status,'pending'),inArray(s.claimRequest.employmentId,[...allowed])));
  return {items:rows.map(row=>({...byEmployment.get(row.employmentId)!,...row})),total:count.total};
 });
}
it('compares an indexed per-subject preview against the current global sort with native audit armed',async()=>{
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

 const expected=new Map<string,unknown>(),phases:Record<string,unknown>={},oldAudit=process.env.AUDIT_HASH_CHAIN_ENABLED;
 process.env.AUDIT_HASH_CHAIN_ENABLED='true';
 try{
  const [audit]=await withTenant(context(users[0]),tx=>tx.execute<{armed:string}>(sql`select current_setting('app.audit_hash_chain',true)as armed`));expect(audit.armed).toBe('on');
  for(const phase of ['current-before','per-subject','current-after']){
   const measurements=[];
   for(const u of users.slice(0,3)){
    const ctx=context(u),read=phase==='per-subject'?experimental:(ctx:SessionContext)=>pendingClaimTaskSummary(ctx,undefined,25),times=[];
    await expect(read({...ctx,personId:randomUUID()})).rejects.toThrow();
    for(let i=0;i<3;i++){
     const start=performance.now(),result=await read(ctx);times.push(performance.now()-start);
     expect(result.total).toBe(u.role==='hr_admin'?100000:u.role==='manager'?20000:0);
     expect(result.items).toHaveLength(Math.min(25,result.total));
     if(!expected.has(u.role))expected.set(u.role,result);else expect(result).toEqual(expected.get(u.role));
    }
    measurements.push({role:u.role,reads:3,elapsedMs:times,exactOrderedPreviewAndCount:true});
   }
   phases[phase]=measurements;writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'claim-preview-window.json'),JSON.stringify({kind:'NATIVE_PREVIEW_QUERY_EXPERIMENT',releaseEligible:false,claims:100000,auditGucVerified:'on',principals:3,phases},null,2));
  }
 }finally{if(oldAudit===undefined)delete process.env.AUDIT_HASH_CHAIN_ENABLED;else process.env.AUDIT_HASH_CHAIN_ENABLED=oldAudit;}
},300000);
