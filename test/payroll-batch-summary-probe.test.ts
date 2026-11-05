/** Native comparison for pages that currently load and discard all payslip detail. */
import {createHash,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import * as s from '../db/schema';
import {withPayrollTenant} from '../core/module-gate';
import {batchDetail,batchHeader,createBatch,generatePayslips} from '../core/payroll';
import {GET as exportRun} from '../app/payroll/[batchId]/export/route';
import {rowsForRun,transactionDetailReport} from '../app/payroll/[batchId]/transaction-detail-report';
import {listPayrollRegisterAcross} from '../core/payroll-view';
import {serializeReport} from '../lib/report-export';
import {PAYROLL_ACCESS_EVENT} from '../core/payroll-audit/access-log';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import type {SessionContext} from '../db/client';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';

const auth=vi.hoisted(()=>({current:null as {s:SessionContext;scopeIds:string[]}|null}));
vi.mock('@/lib/scope',()=>({scopedAdmin:async()=>auth.current}));
beforeAll(migrateTestDb);afterAll(closeAll);

function countProbe(ctx:SessionContext,batchId:string){
 return withPayrollTenant(ctx,async tx=>{
  const [batch]=await tx.select().from(s.payrollHistoryEffectiveBatch).where(eq(s.payrollBatch.id,batchId)).limit(1);
  if(!batch)return null;
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
 // Synthetic owner fixture for the retained historical join: normal void does not accept an existing
 // payslip. Fill the complete void bundle without disabling the database guard or constraint.
 await owner.db.update(s.employment).set({voidedAt:new Date(),voidedBy:b.adminUserId,voidReason:'Fictional retained join fixture',voidedImportAttemptId:randomUUID()}).where(eq(s.employment.id,extra[0].employmentId));
 for(const name of ['person','employment','payslip','payroll_batch','role_assignment'])await owner.client.unsafe('analyze public.'+name);
 const worker:SessionContext={...root,userId:await createAppUser(b.tenantId,target.personId,'employee'),personId:target.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 const [otherCompany]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional out-of-scope company'}).returning({id:s.company.id});
 const [scopedUser]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:randomUUID()}).returning({id:s.appUser.id});
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:scopedUser.id,role:'hr_admin',companyId:otherCompany.id});
 const scoped:SessionContext={...root,userId:scopedUser.id,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:otherCompany.id}]};
 for(const [ctx,id]of [[root,draftId],[root,randomUUID()],[foreign,batchId],[worker,batchId],[scoped,batchId]]as const){
  const old=await batchDetail(ctx,id);
  expect(await batchHeader(ctx,id)).toEqual(old?{batch:old.batch}:null);
  expect(await countProbe(ctx,id)).toEqual(old?{batch:old.batch,slipCount:old.slips.length}:null);
 }
 const exact=await batchDetail(root,batchId);expect(exact?.slips.length).toBe(1000);expect(exact).not.toBeNull();
 const phases=[];
 for(const [name,read,statements]of [
  ['original',()=>batchDetail(root,batchId),2],['header',()=>batchHeader(root,batchId),1],
  ['header-warm',()=>batchHeader(root,batchId),1],['count',()=>countProbe(root,batchId),2],
  ['count-warm',()=>countProbe(root,batchId),2],['restored-original',()=>batchDetail(root,batchId),2],
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
 const req=(id:string)=>exportRun(new Request('https://example.invalid/payroll/'+id+'/export?format=csv'),{params:Promise.resolve({batchId:id})});
 auth.current={s:root,scopeIds:[otherCompany.id]};expect((await req(batchId)).status).toBe(404);
 auth.current={s:foreign,scopeIds:[b.companyId]};expect((await req(batchId)).status).toBe(404);
 auth.current={s:root,scopeIds:[b.companyId]};expect((await req(draftId)).status).toBe(409);
 const batch=exact!.batch;
 const rows=rowsForRun(await listPayrollRegisterAcross(root,{companyIds:[b.companyId],year:2026,month:1,cycle:batch.runType}),batch);
 const expected=await serializeReport(transactionDetailReport({company:rows[0]?.company??batch.companyId,payPeriod:batch.payPeriod,runType:batch.runType,runSeq:batch.runSeq},rows),'csv');
 const response=await req(batchId);expect(response.status).toBe(200);expect(response.headers.get('content-type')).toBe(expected.contentType);
 const bytes=new Uint8Array(await response.arrayBuffer());expect(bytes).toEqual(new Uint8Array(expected.bytes));
 const audit=await owner.db.select().from(s.domainEvent).where(and(eq(s.domainEvent.tenantId,b.tenantId),eq(s.domainEvent.eventType,PAYROLL_ACCESS_EVENT)));
 expect(audit.map(event=>event.payload)).toEqual([expect.objectContaining({action:'export',surface:'run_export',batchId,rows:rows.length,bytes:bytes.byteLength,fileSha256:createHash('sha256').update(bytes).digest('hex')})]);
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'payroll-batch-summary-probe.json'),JSON.stringify({kind:'NATIVE_PAYROLL_BATCH_SUMMARY',releaseEligible:false,physicalMembers:1001,visibleDetailRows:exact?.slips.length,readsPerPhase:5,phases,numericalPayrollCalculationClaim:false},null,2));
},600000);
