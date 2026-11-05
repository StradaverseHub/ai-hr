/** Native comparison for pages that currently load and discard all payslip detail. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import * as s from '../db/schema';
import {withPayrollTenant} from '../core/module-gate';
import {batchDetail,createBatch,generatePayslips} from '../core/payroll';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import type {SessionContext} from '../db/client';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';

beforeAll(migrateTestDb);afterAll(closeAll);

function summary(ctx:SessionContext,batchId:string,count:boolean){
 return withPayrollTenant(ctx,async tx=>{
  const [batch]=await tx.select().from(s.payrollHistoryEffectiveBatch).where(eq(s.payrollBatch.id,batchId)).limit(1);
  if(!batch)return null;
  if(!count)return{batch};
  const [row]=await tx.select({slipCount:sql<number>`count(*)::int`}).from(s.payslip)
   .innerJoin(s.employment,eq(s.employment.id,s.payslip.employmentId))
   .innerJoin(s.person,eq(s.person.id,s.employment.personId))
   .where(eq(s.payslip.batchId,batchId));
  return{batch,slipCount:row.slipCount};
 });
}

it('reads the exact effective header and visible slip count without exporting discarded payroll detail',async()=>{
 await resetDb();const b=await seedBase(),root=adminCtx(b),foreign=adminCtx(await seedBase());
 const target=await hireEmployee(root,{person:{fullName:'Fictional payroll summary person',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employeeCode:'0007',employmentType:'full_time',hiredOn:'2020-01-01'});
 await setCompensation(root,{employmentId:target.employmentId,basicSalary:3000,effectiveFrom:'2020-01-01'});
 await setStatutoryProfileMY(root,{personId:target.personId,icNumber:'900101015551',taxCategory:1,numChildren:0});
 const {batchId}=await createBatch(root,{companyId:b.companyId,payPeriod:'2026-01'});await generatePayslips(root,{batchId});
 const {batchId:draftId}=await createBatch(root,{companyId:b.companyId,payPeriod:'2026-02'});
 const [actual]=await owner.db.select().from(s.payslip).where(eq(s.payslip.batchId,batchId));expect(actual).toBeTruthy();
 const extra=Array.from({length:1000},()=>({personId:randomUUID(),employmentId:randomUUID()}));
 for(let i=0;i<extra.length;i+=100){
  const members=extra.slice(i,i+100);
  await owner.db.insert(s.person).values(members.map(({personId})=>({id:personId,tenantId:b.tenantId,fullName:'Fictional retained payee '+personId,primaryEmail:personId+'@example.invalid'})));
  await owner.db.insert(s.employment).values(members.map(({personId,employmentId})=>({id:employmentId,tenantId:b.tenantId,personId,companyId:b.companyId,hiredOn:'2020-01-01'})));
  await owner.db.insert(s.payslip).values(members.map(({employmentId})=>({...actual,id:randomUUID(),employmentId})));
 }
 // This deliberately tests the exact old detail join: visible employment/person filtering affects its length.
 await owner.db.update(s.employment).set({voidedAt:new Date()}).where(eq(s.employment.id,extra[0].employmentId));
 for(const name of ['person','employment','payslip','payroll_batch','role_assignment'])await owner.client.unsafe('analyze public.'+name);
 const worker:SessionContext={...root,userId:await createAppUser(b.tenantId,target.personId,'employee'),personId:target.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 const [otherCompany]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional out-of-scope company'}).returning({id:s.company.id});
 const [scopedUser]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:randomUUID()}).returning({id:s.appUser.id});
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:scopedUser.id,role:'hr_admin',companyId:otherCompany.id});
 const scoped:SessionContext={...root,userId:scopedUser.id,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:otherCompany.id}]};
 for(const [ctx,id]of [[root,draftId],[root,randomUUID()],[foreign,batchId],[worker,batchId],[scoped,batchId]]as const){
  const old=await batchDetail(ctx,id);
  expect(await summary(ctx,id,false)).toEqual(old?{batch:old.batch}:null);
  expect(await summary(ctx,id,true)).toEqual(old?{batch:old.batch,slipCount:old.slips.length}:null);
 }
 const exact=await batchDetail(root,batchId);expect(exact?.slips.length).toBe(1000);
 const phases=[];
 for(const [name,read,statements]of [
  ['original',()=>batchDetail(root,batchId),2],['header',()=>summary(root,batchId,false),1],
  ['header-warm',()=>summary(root,batchId,false),1],['count',()=>summary(root,batchId,true),2],
  ['count-warm',()=>summary(root,batchId,true),2],['restored-original',()=>batchDetail(root,batchId),2],
 ] as const){
  let elapsedMs=0,bytes=0;
  for(let i=0;i<5;i++){
   const start=performance.now(),result=await read();elapsedMs+=performance.now()-start;bytes+=Buffer.byteLength(JSON.stringify(result));
   expect(result?.batch).toEqual(exact?.batch);
   if(result&&'slips'in result)expect(result.slips).toEqual(exact?.slips);
   if(result&&'slipCount'in result)expect(result.slipCount).toBe(exact?.slips.length);
  }
  phases.push({name,elapsedMs,bytes,bodyQueriesPerRead:statements});
 }
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'payroll-batch-summary-probe.json'),JSON.stringify({kind:'NATIVE_PAYROLL_BATCH_SUMMARY',releaseEligible:false,physicalMembers:1001,visibleDetailRows:exact?.slips.length,readsPerPhase:5,phases,numericalPayrollCalculationClaim:false},null,2));
},600000);
