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
 await resetDb();await owner.client.unsafe('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');await owner.client`select pg_stat_statements_reset()`;const b=await seedBase();await setModule(b.tenantId,'claims','active');const base=adminCtx(b);
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
 const [originalFunction]=await owner.client`select pg_get_functiondef(oid) as definition,prosrc as body,proowner::text,proacl::text,prosecdef,provolatile,proconfig,proparallel,proleakproof from pg_proc where oid='app.delegation_line_covers(uuid,uuid,text,text)'::regprocedure`;
 const predicate='EXISTS(SELECT 1 FROM public.app_user u WHERE u.person_id=delegate.person_id AND u.tenant_id=d.tenant_id AND u.archived_at IS NULL AND NOT app.login_blocked(u.id))';
 const fenced='EXISTS(WITH candidate_users AS MATERIALIZED (SELECT u.id FROM public.app_user u WHERE u.person_id=delegate.person_id AND u.tenant_id=d.tenant_id AND u.archived_at IS NULL) SELECT 1 FROM candidate_users u WHERE NOT app.login_blocked(u.id))';
 expect(originalFunction.body.split(predicate)).toHaveLength(2);
 const policySnapshot=await owner.client`select polname,polcmd,polpermissive,polroles::text,pg_get_expr(polqual,polrelid) as qual,pg_get_expr(polwithcheck,polrelid) as check_expr from pg_policy where polrelid='public.claim_request'::regclass order by polname`;
 const original=()=>owner.client.unsafe(originalFunction.definition);
 const expected=new Map<string,Awaited<ReturnType<typeof pendingClaimTaskSummary>>>(),phases:Record<string,unknown>={};
 try{
  for(const phase of ['original-before','candidate-user-fence','original-restored']){
   if(phase==='candidate-user-fence')await owner.client.unsafe(originalFunction.definition.replace(predicate,fenced));
   if(phase==='original-restored')await original();
   const [observed]=await owner.client`select pg_get_functiondef(oid) as definition,prosrc as body,proowner::text,proacl::text,prosecdef,provolatile,proconfig,proparallel,proleakproof from pg_proc where oid='app.delegation_line_covers(uuid,uuid,text,text)'::regprocedure`;
   const {definition:oldDefinition,body:oldBody,...oldAttributes}=originalFunction;
   const {definition:currentDefinition,body:currentBody,...currentAttributes}=observed;
   expect(currentAttributes).toEqual(oldAttributes);
   expect(currentDefinition).toBe(phase==='candidate-user-fence'?oldDefinition.replace(predicate,fenced):oldDefinition);
   expect(currentBody).toBe(phase==='candidate-user-fence'?oldBody.replace(predicate,fenced):oldBody);
   expect(await owner.client`select polname,polcmd,polpermissive,polroles::text,pg_get_expr(polqual,polrelid) as qual,pg_get_expr(polwithcheck,polrelid) as check_expr from pg_policy where polrelid='public.claim_request'::regclass order by polname`).toEqual(policySnapshot);
   const measurements=[];
   for(const u of phase==='original-restored'?[users[502]]:[...users.slice(0,3),users[502]]){
    const actor=u===users[502]?'delegate':u.role,ctx=context(u),times=[];
    await expect(pendingClaimTaskSummary({...ctx,personId:randomUUID()},undefined,25)).rejects.toThrow();
    await owner.client`select pg_stat_statements_reset()`;
    for(let i=0;i<1;i++){
     const start=performance.now(),result=await pendingClaimTaskSummary(ctx,undefined,25);times.push(performance.now()-start);
     expect(result.total).toBe(actor==='hr_admin'?1000000:actor==='employee'?0:200000);
     expect(result.items).toHaveLength(actor==='employee'?0:25);
     if(!expected.has(actor))expected.set(actor,result);else expect(result).toEqual(expected.get(actor));
    }
    const statements=await owner.client`select queryid::text,calls,total_exec_time,rows,left(query,1800) as query from pg_stat_statements where dbid=(select oid from pg_database where datname=current_database()) and query not ilike '%pg_stat_%' order by total_exec_time desc limit 8`;
    const [raw]=await withClaimsTenant(ctx,tx=>tx.execute<{total:number}>(sql`select count(*)::int as total from public.claim_request`));
    expect(raw.total).toBe(actor==='hr_admin'?1000001:actor==='manager'?200001:actor==='employee'?2001:200000);
    expect(await pendingClaimTaskSummary(ctx,[],25)).toEqual({items:[],total:0});
    measurements.push({actor,reads:1,elapsedMs:times,exactTotal:true,exactOrderedPreview:true,rawRlsCount:raw.total,delegateDraftExcluded:true,statements});
    phases[phase]=measurements;
    writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'claim-task-reader.json'),JSON.stringify({kind:'REVERSIBLE_DELEGATION_USER_FENCE_ONLY_PROBE',releaseEligible:false,claims:1000000,drafts:1,employments:503,pendingSubjects:500,readerPrincipals:4,functionAttributesPreserved:true,policiesUnchanged:true,phases},null,2));
   }
   phases[phase]=measurements;
   writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'claim-task-reader.json'),JSON.stringify({kind:'REVERSIBLE_DELEGATION_USER_FENCE_ONLY_PROBE',releaseEligible:false,claims:1000000,drafts:1,employments:503,pendingSubjects:500,readerPrincipals:4,functionAttributesPreserved:true,policiesUnchanged:true,phases},null,2));
  }
 }finally{await original();}
},300000);
