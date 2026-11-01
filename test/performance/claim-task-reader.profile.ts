/** Paired populated native queue comparison; no HTTP capacity or release claim. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {sql} from 'drizzle-orm';
import {withClaimsTenant} from '../../core/module-gate';
import {afterAll,beforeAll,expect,it} from 'vitest';
import type {SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {createClaimType,pendingClaimTaskSummary} from '../../packs/claims/service';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('checks the actual counted Claims application summary over one million records and500subjects',async()=>{
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'claims','active');const base=adminCtx(b);
 const type=await createClaimType(base,{code:'PERF_META',name:'Fictional paired metadata',requiresReceipt:false,defaultTaxable:false});
 const users=Array.from({length:503},(_,i)=>({id:randomUUID(),personId:randomUUID(),employmentId:randomUUID(),role:i===0?'hr_admin' as const:i===1||i===502?'manager' as const:'employee' as const}));
 await owner.db.insert(s.person).values(users.map((u,i)=>({id:u.personId,tenantId:b.tenantId,fullName:'Fictional metadata subject '+i,primaryEmail:u.id+'@example.invalid'})));
 await owner.db.insert(s.employment).values(users.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:b.companyId,hiredOn:'2020-01-01'})));
 await owner.db.insert(s.appUser).values(users.map(u=>({id:u.id,tenantId:b.tenantId,personId:u.personId,workosUserId:'metadata_'+u.id})));
 await owner.db.insert(s.roleAssignment).values(users.map(u=>({tenantId:b.tenantId,appUserId:u.id,role:u.role,companyId:u.role==='hr_admin'?null:b.companyId})));
 await owner.db.insert(s.reportingLine).values(users.slice(2,102).map(u=>({tenantId:b.tenantId,managerEmploymentId:users[1].employmentId,subordinateEmploymentId:u.employmentId,lineType:'administrative' as const,validFrom:'2020-01-01'})));
 await owner.client`insert into claim_request(tenant_id,employment_id,claim_type_id,amount,incurred_on,status,created_at)
  select ${b.tenantId}::uuid,e.id,${type.id}::uuid,1,current_date,'pending',now()-n*interval '1 minute'
  from unnest(${users.slice(2,502).map(u=>u.employmentId)}::uuid[])e(id)cross join generate_series(1,2000)n`;
 for(const table of ['person','employment','app_user','role_assignment','claim_request','reporting_line'])await owner.client.unsafe('analyze '+table);
 await owner.db.insert(s.reportingLine).values({tenantId:b.tenantId,managerEmploymentId:users[502].employmentId,subordinateEmploymentId:users[1].employmentId,lineType:'delegate',validFrom:'2020-01-01'});
 await owner.db.insert(s.claimRequest).values({tenantId:b.tenantId,employmentId:users[2].employmentId,claimTypeId:type.id,amount:'1',incurredOn:'2026-01-01',status:'draft'});
 const context=(u:typeof users[number]):SessionContext=>({...base,userId:u.id,personId:u.personId,roles:[u.role],grants:[{role:u.role,companyId:u.role==='hr_admin'?null:b.companyId}]});
 const policies=await owner.client`select polname,polcmd,polpermissive,polroles::text,pg_get_expr(polqual,polrelid) as qual,pg_get_expr(polwithcheck,polrelid) as check_expr from pg_policy where polrelid='public.claim_request'::regclass order by polname`;
 const modified=['claim_request_rls','claim_delegate_read'];
 for(const name of modified)expect(policies.find(row=>row.polname===name)).toBeDefined();
 const enumOperators=await owner.client`select proname,proleakproof from pg_proc where proname in ('enum_eq','uuid_eq') order by proname`;
 const original=async()=>{for(const name of modified){const policy=policies.find(row=>row.polname===name)!;await owner.client.unsafe('ALTER POLICY '+name+' ON public.claim_request USING ('+policy.qual+')');}};
 const expected=new Map<string,Awaited<ReturnType<typeof pendingClaimTaskSummary>>>(),phases:Record<string,unknown>={};
 try{
  for(const phase of ['original-before','hashed-membership','original-restored']){
   if(phase==='hashed-membership'){
    await owner.client.unsafe("ALTER POLICY claim_request_rls ON public.claim_request USING (tenant_id=app.current_tenant_id() AND employment_id IN (SELECT unnest(app.visible_employment_ids())))");
    await owner.client.unsafe("ALTER POLICY claim_delegate_read ON public.claim_request USING (tenant_id=app.current_tenant_id() AND status::text<>'draft' AND employment_id IN (SELECT unnest(app.delegated_subject_ids('claims','claims.claim'))))");
   }
   if(phase==='original-restored')await original();
   const actualPolicies=await owner.client`select polname,polcmd,polpermissive,polroles::text,pg_get_expr(polqual,polrelid) as qual,pg_get_expr(polwithcheck,polrelid) as check_expr from pg_policy where polrelid='public.claim_request'::regclass order by polname`;
   expect(actualPolicies.map(({qual,...attrs})=>attrs)).toEqual(policies.map(({qual,...attrs})=>attrs));
   if(phase!=='hashed-membership')expect(actualPolicies).toEqual(policies);
   const measurements=[];
   for(const u of [...users.slice(0,3),users[502]]){
    const actor=u===users[502]?'delegate':u.role,ctx=context(u),times=[];
    await expect(pendingClaimTaskSummary({...ctx,personId:randomUUID()},undefined,25)).rejects.toThrow();
    for(let i=0;i<3;i++){
     const start=performance.now(),result=await pendingClaimTaskSummary(ctx,undefined,25);times.push(performance.now()-start);
     expect(result.total).toBe(actor==='hr_admin'?1000000:actor==='employee'?0:200000);
     expect(result.items).toHaveLength(actor==='employee'?0:25);
     if(!expected.has(actor))expected.set(actor,result);else expect(result).toEqual(expected.get(actor));
    }
    const [raw]=await withClaimsTenant(ctx,tx=>tx.execute<{total:number}>(sql`select count(*)::int as total from public.claim_request`));
    expect(raw.total).toBe(actor==='hr_admin'?1000001:actor==='manager'?200001:actor==='employee'?2001:200000);
    expect(await pendingClaimTaskSummary(ctx,[],25)).toEqual({items:[],total:0});
    measurements.push({actor,reads:3,elapsedMs:times,exactTotal:true,exactOrderedPreview:true,rawRlsCount:raw.total,delegateDraftExcluded:true});
   }
   phases[phase]=measurements;
   writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'claim-task-reader.json'),JSON.stringify({kind:'REVERSIBLE_NATIVE_RLS_MEMBERSHIP_PROBE',releaseEligible:false,claims:1000000,drafts:1,employments:503,pendingSubjects:500,readerPrincipals:4,policyAttributesPreserved:true,enumOperators,phases},null,2));
  }
 }finally{await original();}
},300000);
