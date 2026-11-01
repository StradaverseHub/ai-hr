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
 const results=[];
 for(const u of [...users.slice(0,3),users[502]]){
  const actor=u===users[502]?'delegate':u.role,ctx=context(u);
  await owner.client`select pg_stat_statements_reset()`;
  const start=performance.now(),actual=await pendingClaimTaskSummary(ctx,undefined,25),serviceMs=performance.now()-start;
  expect(actual.total).toBe(actor==='hr_admin'?1000000:actor==='employee'?0:200000);
  const serviceStatements=await owner.client`select queryid::text,calls,total_exec_time,rows,left(query,1800) as query from pg_stat_statements where dbid=(select oid from pg_database where datname=current_database()) and query not ilike '%pg_stat_%' order by total_exec_time desc limit 8`;
  const allowed=(actor==='hr_admin'?users.slice(2,502):actor==='employee'?[]:users.slice(2,102)).map(row=>row.employmentId);
  const timings=[];
  if(allowed.length)await withClaimsTenant(ctx,async tx=>{
   await tx.execute(sql`SET LOCAL jit = off`);
   for(const shape of ['lateral','global','lateral-restored']){
    const started=performance.now();
    const rows=await tx.execute<{id:string;employmentId:string}>(shape==='global'?sql`
     select id,employment_id as "employmentId" from public.claim_request
     where tenant_id=${b.tenantId}::uuid and status='pending' and employment_id=ANY(ARRAY[${sql.join(allowed.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[])
     order by created_at desc,id asc limit 25
    `:sql`
     select headers.id,headers.employment_id as "employmentId"
     from (VALUES ${sql.join(allowed.map(id=>sql`(${id}::uuid)`),sql`, `)}) as subject(employment_id)
     inner join lateral (
      select id,employment_id,created_at from public.claim_request
      where tenant_id=${b.tenantId}::uuid and status='pending' and employment_id=subject.employment_id
      order by created_at desc,id asc limit 25
     ) headers on true order by headers.created_at desc,headers.id asc limit 25
    `);
    const elapsedMs=performance.now()-started;
    expect(rows.map(row=>({id:row.id,employmentId:row.employmentId}))).toEqual(actual.items.map(row=>({id:row.id,employmentId:row.employmentId})));
    timings.push({shape,elapsedMs,exactOrderedNativePreview:true});
   }
  });
  results.push({actor,serviceMs,serviceStatements,timings,exactCount:actual.total});
  writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'claim-task-reader.json'),JSON.stringify({kind:'NATIVE_PREVIEW_QUERY_SHAPE_ONLY',releaseEligible:false,claims:1000000,employments:503,policiesUnchanged:true,authorityAndCountOwnerUnchanged:true,results},null,2));
 }
},300000);
