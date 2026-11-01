/** Paired populated native queue comparison; no HTTP capacity or release claim. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import type {SessionContext} from '../../db/client';
import * as s from '../../db/schema';
import {createClaimType,pendingClaimTaskSummary} from '../../packs/claims/service';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('checks the actual counted Claims application summary over one million records and500subjects',async()=>{
 await resetDb();const b=await seedBase();await setModule(b.tenantId,'claims','active');const base=adminCtx(b);
 const type=await createClaimType(base,{code:'PERF_META',name:'Fictional paired metadata',requiresReceipt:false,defaultTaxable:false});
 const users=Array.from({length:502},(_,i)=>({id:randomUUID(),personId:randomUUID(),employmentId:randomUUID(),role:i===0?'hr_admin' as const:i===1?'manager' as const:'employee' as const}));
 await owner.db.insert(s.person).values(users.map((u,i)=>({id:u.personId,tenantId:b.tenantId,fullName:'Fictional metadata subject '+i,primaryEmail:u.id+'@example.invalid'})));
 await owner.db.insert(s.employment).values(users.map(u=>({id:u.employmentId,tenantId:b.tenantId,personId:u.personId,companyId:b.companyId,hiredOn:'2020-01-01'})));
 await owner.db.insert(s.appUser).values(users.map(u=>({id:u.id,tenantId:b.tenantId,personId:u.personId,workosUserId:'metadata_'+u.id})));
 await owner.db.insert(s.roleAssignment).values(users.map(u=>({tenantId:b.tenantId,appUserId:u.id,role:u.role,companyId:u.role==='hr_admin'?null:b.companyId})));
 await owner.db.insert(s.reportingLine).values(users.slice(2,102).map(u=>({tenantId:b.tenantId,managerEmploymentId:users[1].employmentId,subordinateEmploymentId:u.employmentId,lineType:'administrative' as const,validFrom:'2020-01-01'})));
 await owner.client`insert into claim_request(tenant_id,employment_id,claim_type_id,amount,incurred_on,status,created_at)
  select ${b.tenantId}::uuid,e.id,${type.id}::uuid,1,current_date,'pending',now()-n*interval '1 minute'
  from unnest(${users.slice(2).map(u=>u.employmentId)}::uuid[])e(id)cross join generate_series(1,2000)n`;
 for(const table of ['person','employment','app_user','role_assignment','claim_request','reporting_line'])await owner.client.unsafe('analyze '+table);
 const context=(u:typeof users[number]):SessionContext=>({...base,userId:u.id,personId:u.personId,roles:[u.role],grants:[{role:u.role,companyId:u.role==='hr_admin'?null:b.companyId}]});
 const measurements=[];
 for(const u of users.slice(0,3)){
  const ctx=context(u),times=[];
  await expect(pendingClaimTaskSummary({...ctx,personId:randomUUID()},undefined,25)).rejects.toThrow();
  for(let i=0;i<3;i++){
   const start=performance.now(),result=await pendingClaimTaskSummary(ctx,undefined,25);times.push(performance.now()-start);
   expect(result.total).toBe(u.role==='hr_admin'?1000000:u.role==='manager'?200000:0);
   expect(result.items).toHaveLength(u.role==='employee'?0:25);
   expect(new Set(result.items.map(row=>row.id)).size).toBe(result.items.length);
   for(const row of result.items)expect(users.find(subject=>subject.employmentId===row.employmentId)?.role).toBe('employee');
  }
  expect(await pendingClaimTaskSummary(ctx,[],25)).toEqual({items:[],total:0});
  measurements.push({role:u.role,reads:3,elapsedMs:times,exactTotal:true,previewBounded:true});
  writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'claim-task-reader.json'),JSON.stringify({kind:'ACTUAL_NATIVE_CLAIM_SUMMARY_SCALE',releaseEligible:false,claims:1000000,employments:502,pendingSubjects:500,readerPrincipals:3,measurements},null,2));
 }
},300000);
