/** Native comparison for pages that currently load and discard all payslip detail. */
import {createHash,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import * as s from '../db/schema';
import {lockPayrollHistoryWriteTx} from '../core/payroll-history-lock';
import {batchDetail,batchHeader,batchSummary,payrollEmployeeSelectionPage,payslipLessEligiblePage,listPayslipLessEligible,listRemovableEmployees,createBatch,generatePayslips,listBatchRecalcPayslipIdentities,payrollRunRegisterPage} from '../core/payroll';
import {GET as exportRun} from '../app/payroll/[batchId]/export/route';
import {rowsForRun,transactionDetailReport} from '../app/payroll/[batchId]/transaction-detail-report';
import {listPayrollRegisterAcross} from '../core/payroll-view';
import {serializeReport} from '../lib/report-export';
import {paginateRows,parsePageQuery} from '../lib/pagination';
import {PAYROLL_ACCESS_EVENT} from '../core/payroll-audit/types';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import type {SessionContext} from '../db/client';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';

const auth=vi.hoisted(()=>({current:null as {s:SessionContext;scopeIds:string[]}|null}));
vi.mock('@/lib/scope',()=>({scopedAdmin:async()=>auth.current}));
beforeAll(migrateTestDb);afterAll(closeAll);

it('reads the exact effective header and visible slip count without exporting discarded payroll detail',async()=>{
 await resetDb();const b=await seedBase(),root=adminCtx(b),foreign=adminCtx(await seedBase());
 const target=await hireEmployee(root,{person:{fullName:'Fictional payroll summary person',primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employeeCode:'0007',employmentType:'full_time',hiredOn:'2020-01-01'});
 await setCompensation(root,{employmentId:target.employmentId,basicSalary:3000,effectiveFrom:'2020-01-01'});
 await setStatutoryProfileMY(root,{personId:target.personId,icNumber:'900101015551',taxCategory:1,numChildren:0});
 const [cycle]=await owner.db.insert(s.payrollCycle).values({tenantId:b.tenantId,companyId:b.companyId,name:'Fictional monthly',code:'REG',runType:'regular'}).returning();
 const {batchId}=await createBatch(root,{companyId:b.companyId,payPeriod:'2026-01',payrollCycleId:cycle.id});await generatePayslips(root,{batchId});
 const {batchId:draftId}=await createBatch(root,{companyId:b.companyId,payPeriod:'2026-02'});
 const [actual]=await owner.db.select().from(s.payslip).where(eq(s.payslip.batchId,batchId));expect(actual).toBeTruthy();
 const extra=Array.from({length:1000},()=>({personId:randomUUID(),employmentId:randomUUID()}));
 for(let i=0;i<extra.length;i+=100){
  const members=extra.slice(i,i+100);
  await owner.db.insert(s.person).values(members.map(({personId})=>({id:personId,tenantId:b.tenantId,fullName:'Fictional retained payee '+personId,primaryEmail:personId+'@example.invalid'})));
  await owner.db.insert(s.employment).values(members.map(({personId,employmentId})=>({id:employmentId,tenantId:b.tenantId,personId,companyId:b.companyId,hiredOn:'2020-01-01'})));
  await owner.db.insert(s.payslip).values(members.map(({employmentId})=>({...actual,id:randomUUID(),employmentId})));
 }
 await owner.db.update(s.person).set({fullName:'Fictional duplicate payee'}).where(sql`${s.person.id} in (${extra[1].personId}::uuid,${extra[2].personId}::uuid)`);
 // Synthetic owner fixture for the retained historical join: normal void does not accept an existing
 // payslip. Fill the complete void bundle without disabling the database guard or constraint.
 await owner.db.update(s.employment).set({voidedAt:new Date(),voidedBy:b.adminUserId,voidReason:'Fictional retained join fixture',voidedImportAttemptId:randomUUID()}).where(eq(s.employment.id,extra[0].employmentId));
 for(const name of ['person','employment','payslip','payroll_batch','role_assignment'])await owner.client.unsafe('analyze public.'+name);
 const worker:SessionContext={...root,userId:await createAppUser(b.tenantId,target.personId,'employee'),personId:target.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 // Group shape: the count stays SQL-side even when the tenant has seventy companies.
 await owner.db.insert(s.company).values(Array.from({length:69},(_,i)=>({tenantId:b.tenantId,legalName:'Fictional summary group '+i})));
 const [otherCompany]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional out-of-scope company'}).returning({id:s.company.id});
 const [scopedUser]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:randomUUID()}).returning({id:s.appUser.id});
 await owner.db.insert(s.roleAssignment).values({tenantId:b.tenantId,appUserId:scopedUser.id,role:'hr_admin',companyId:otherCompany.id});
 const scoped:SessionContext={...root,userId:scopedUser.id,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:otherCompany.id}]};
 for(const [ctx,id]of [[root,draftId],[root,randomUUID()],[foreign,batchId],[worker,batchId],[scoped,batchId]]as const){
  const old=await batchDetail(ctx,id);
  expect(await batchHeader(ctx,id)).toEqual(old?{batch:old.batch}:null);
  expect(await batchSummary(ctx,id)).toEqual(old?{batch:old.batch,slipCount:old.slips.length}:null);
  const page=parsePageQuery();
  expect(await payrollRunRegisterPage(ctx,id,page)).toEqual(old?{batch:old.batch,closeCycleName:old.batch.status==='processed'?cycle.name:null,runPayslipCount:old.slips.length,slipPage:paginateRows(old.slips.map(({totalDeductions:_d,employerCost:_c,...row})=>row),page)}:null);
 }
 // Exercise every native role, group-wide and company-scoped, with real matching assignments.
 for(const role of s.roleEnum.enumValues)for(const companyId of (role==='super_admin'?[null]:[null,b.companyId,otherCompany.id])){
  const userId=await createAppUser(b.tenantId,null,'employee');
  await owner.db.update(s.roleAssignment).set({role,companyId}).where(eq(s.roleAssignment.appUserId,userId));
  const who:SessionContext={...root,userId,personId:null,roles:[role],grants:[{role,companyId}]};
  const outcome=async(read:()=>Promise<unknown>)=>{try{return{value:await read()};}catch(e){return{error:String(e)};}};
  const old=await outcome(async()=>{const d=await batchDetail(who,batchId);return d?{batch:d.batch,slipCount:d.slips.length}:null;});
  expect(await outcome(()=>batchSummary(who,batchId)),`${role}:${companyId??'all'}`).toEqual(old);
  const removed=await outcome(()=>listRemovableEmployees(who,{batchId}));
  const paged=await outcome(()=>payrollEmployeeSelectionPage(who,{batchId,kind:'remove',page:parsePageQuery()}));
  if('error'in removed)expect(paged).toEqual(removed);
  else{
   const rows=removed.value as Awaited<ReturnType<typeof listRemovableEmployees>>;
   const page=(paged as {value:Awaited<ReturnType<typeof payrollEmployeeSelectionPage>>}).value;
   expect(page.runTotal).toBe(rows.length);expect(page.state.total).toBe(rows.length);
   expect(new Set(page.rows.map(row=>row.employmentId))).toEqual(new Set(rows.slice(0,25).map(row=>row.employmentId)));
  }

 }
 const exact=await batchDetail(root,batchId);expect(exact?.slips.length).toBe(1000);expect(exact).not.toBeNull();
 const list=exact!.slips;
 const groupByName=new Map<string,typeof list>();
 for(const row of list){
  const group=groupByName.get(row.name);
  if(group)group.push(row);else groupByName.set(row.name,[row]);
 }
 const ordered=[...groupByName.values()].flatMap(group=>group.sort((a,b)=>a.id.localeCompare(b.id)));
 const registerRows=ordered.map(({totalDeductions:_deductions,employerCost:_cost,...row})=>row);
 const tied=registerRows.filter(row=>row.name==='Fictional duplicate payee');
 expect(tied).toHaveLength(2);
 for(const raw of [{},{page:'1',size:'50'},{page:'200',size:'200'},{page:String(Number.MAX_SAFE_INTEGER),size:'200'},{size:'all'}]){
  const page=parsePageQuery(raw);
  expect(await payrollRunRegisterPage(root,batchId,page)).toEqual({batch:exact!.batch,closeCycleName:cycle.name,runPayslipCount:registerRows.length,slipPage:paginateRows(registerRows,page)});
 }
 const removable=await listRemovableEmployees(root,{batchId}),removeBy=new Map(removable.map(row=>[row.employmentId,row]));
 for(const raw of [{},{page:'1',size:'50'},{page:'99',size:'200'},{page:String(Number.MAX_SAFE_INTEGER),size:'200'},{size:'all'}])for(const kind of ['remove','reprocess'] as const){
  const query=parsePageQuery(raw),actual=await payrollEmployeeSelectionPage(root,{batchId,kind,page:query});
  const expected=paginateRows(registerRows,query);
  expect(actual.state).toEqual(expected.state);expect(actual.runTotal).toBe(1000);
  expect(actual.rows.map(row=>({id:row.id,employmentId:row.employmentId,gross:row.gross,net:row.net,version:row.version})))
   .toEqual(expected.rows.map(row=>({id:row.id,employmentId:row.employmentId,gross:row.gross,net:row.net,version:row.version})));
  if(kind==='remove')expect(actual.rows.map(({id:_id,version:_v,...row})=>row)).toEqual(expected.rows.map(row=>removeBy.get(row.employmentId)));
 }
 for(const q of ['Fictional duplicate','not present','%','_']){
  const actual=await payrollEmployeeSelectionPage(root,{batchId,kind:'reprocess',page:parsePageQuery(),search:q});
  const expected=registerRows.filter(row=>row.name.toLowerCase().includes(q.toLowerCase())||(row.employeeCode??'').toLowerCase().includes(q.toLowerCase()));
  expect(actual.state.total).toBe(expected.length);expect(actual.rows.map(row=>row.id)).toEqual(expected.slice(0,25).map(row=>row.id));expect(actual.runTotal).toBe(1000);
 }
 expect(Buffer.byteLength(JSON.stringify((await payrollEmployeeSelectionPage(root,{batchId,kind:'reprocess',page:parsePageQuery()})).rows))).toBeLessThan(Buffer.byteLength(JSON.stringify(exact))/10);
 const firstPage=registerRows.slice(0,25),offPage=registerRows.at(-1)!;
 expect(firstPage.some(row=>row.employmentId===offPage.employmentId)).toBe(false);
 const bannerIds=[offPage.employmentId,extra[0].employmentId,firstPage[0].employmentId.toUpperCase(),'not-a-uuid'];
 expect(await listBatchRecalcPayslipIdentities(root,batchId,bannerIds)).toEqual([{
  employmentId:offPage.employmentId,name:offPage.name,employeeCode:offPage.employeeCode,
 }]);
 expect(await listBatchRecalcPayslipIdentities(foreign,batchId,bannerIds)).toEqual([]);
 const phases=[];
 for(const [name,read,statements]of [
  ['original',()=>batchDetail(root,batchId),2],['register-page',()=>payrollRunRegisterPage(root,batchId,parsePageQuery()),2],['header',()=>batchHeader(root,batchId),1],
  ['header-warm',()=>batchHeader(root,batchId),1],['count',()=>batchSummary(root,batchId),2],
  ['count-warm',()=>batchSummary(root,batchId),2],
  ['register-page-repeat',()=>payrollRunRegisterPage(root,batchId,parsePageQuery()),2],['restored-original',()=>batchDetail(root,batchId),2],
 ] as const){
  let elapsedMs=0,bytes=0;
  for(let i=0;i<5;i++){
   const start=performance.now(),result=await read();elapsedMs+=performance.now()-start;bytes+=Buffer.byteLength(JSON.stringify(result));
   expect(result?.batch).toEqual(exact?.batch);
   if(result&&'slips'in result)expect(result.slips).toEqual(exact?.slips);
   if(result&&'slipCount'in result)expect(result.slipCount).toBe(exact?.slips.length);
   if(result&&'slipPage'in result)expect(result.slipPage).toEqual(paginateRows(registerRows,parsePageQuery()));
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
 // The ordinary tenant bootstrap runs before the History lock. A queued register read must
 // use the snapshot after the holder commits, including the joined count and the displayed page.
 let waitingRead: ReturnType<typeof payrollRunRegisterPage> | undefined;
 let waitingSummary: ReturnType<typeof batchSummary> | undefined;
 let waitingSelection: ReturnType<typeof payrollEmployeeSelectionPage> | undefined;
 try {
  await owner.db.transaction(async tx => {
   await lockPayrollHistoryWriteTx(tx, b.tenantId);
   const [holder] = await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);
   await tx.update(s.employment).set({
    voidedAt:new Date(), voidedBy:b.adminUserId, voidReason:'Fictional concurrent history change', voidedImportAttemptId:randomUUID(),
   }).where(eq(s.employment.id, firstPage[0].employmentId));
   waitingRead = payrollRunRegisterPage(root, batchId, parsePageQuery());
   waitingSummary = batchSummary(root,batchId);
   waitingSelection = payrollEmployeeSelectionPage(root,{batchId,kind:'remove',page:parsePageQuery()});
   void waitingSelection.catch(() => undefined);
   void waitingSummary.catch(() => undefined);
   void waitingRead.catch(() => undefined);
   const deadline = performance.now() + 7_000;
   let blocked = false;
   while (!blocked && performance.now() < deadline) {
    const [lock] = await owner.db.execute<{blocked:boolean}>(sql`select exists (
     select 1 from pg_locks l where l.locktype='advisory' and not l.granted
     and ${holder.pid}::integer=any(pg_blocking_pids(l.pid))
    ) as blocked`);
    blocked = lock.blocked;
    if (!blocked) await new Promise(resolve => setTimeout(resolve, 15));
   }
   expect(blocked, 'register read must wait for the history writer').toBe(true);
  });
  expect((await waitingRead)?.slipPage).toEqual(paginateRows(registerRows.slice(1), parsePageQuery()));
  expect((await waitingSummary)?.slipCount).toBe(registerRows.length-1);
  const selection=await waitingSelection;
  expect(selection?.runTotal).toBe(registerRows.length-1);
  expect(selection?.rows.map(r=>r.id)).toEqual(registerRows.slice(1,26).map(r=>r.id));
 } finally {
  await waitingRead?.catch(() => undefined);
  await waitingSummary?.catch(() => undefined);
  await waitingSelection?.catch(() => undefined);
 }
 expect(phases.find(p=>p.name==='count')!.bytes).toBeLessThan(phases.find(p=>p.name==='original')!.bytes/10);
 // Independently exercise an unpaid population larger than a page. Native readiness must agree with
 // the old complete reader; the page cannot quietly change dated eligibility, scope or blocker meaning.
 const unpaid=Array.from({length:1000},(_,i)=>({personId:randomUUID(),employmentId:randomUUID(),i}));
 await owner.db.insert(s.person).values(unpaid.map(row=>({id:row.personId,tenantId:b.tenantId,fullName:'Fictional unpaid '+String(row.i).padStart(4,'0'),primaryEmail:row.personId+'@example.invalid'})));
 await owner.db.insert(s.employment).values(unpaid.map(row=>({id:row.employmentId,tenantId:b.tenantId,personId:row.personId,companyId:b.companyId,hiredOn:'2020-01-01',employeeCode:'NEW-'+String(row.i).padStart(4,'0')})));
 const complete=await listPayslipLessEligible(root,{batchId});expect(complete).toHaveLength(1000);
 for(const raw of [{},{page:'2',size:'50'},{size:'all'},{page:String(Number.MAX_SAFE_INTEGER),size:'200'}]){
  const query=parsePageQuery(raw),actual=await payslipLessEligiblePage(root,{batchId,page:query});
  expect(actual).toEqual({...paginateRows(complete,query),runTotal:1000});
 }
 const searched=await payslipLessEligiblePage(root,{batchId,page:parsePageQuery(),search:'NEW0007'});
 expect(searched.state.total).toBe(1);expect(searched.rows[0].employeeCode).toBe('NEW-0007');expect(searched.runTotal).toBe(1000);
 for(const ctx of [foreign,worker,scoped])expect((await payslipLessEligiblePage(ctx,{batchId,page:parsePageQuery()})).rows).toEqual(await listPayslipLessEligible(ctx,{batchId}));
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'payroll-selection-paging-probe.json'),JSON.stringify({kind:'NATIVE_PAYROLL_SELECTION_PAGING',releaseEligible:false,groupCompanies:71,physicalEmployments:2001,paidPopulationBeforeHistoryChange:1000,unpaidPopulationBeforeHistoryChange:1000,pageDefault:25,equivalentRowsCountsAndReadiness:true,allNativeRolesAndGroupCompanyScopes:true,financialCommandsChanged:false},null,2));
 const bestBeforeMs = Math.min(...phases.filter(p => p.name === 'original' || p.name === 'restored-original').map(p => p.elapsedMs));
 const worstAfterMs = Math.max(...phases.filter(p => p.name.startsWith('register-page')).map(p => p.elapsedMs));
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'payroll-batch-summary-probe.json'),JSON.stringify({kind:'NATIVE_PAYROLL_BATCH_SUMMARY',releaseEligible:false,physicalMembers:1001,groupCompanies:71,visibleDetailRows:exact?.slips.length,readsPerPhase:5,phases,comparison:{bestBeforeMs,worstAfterMs,noRegression:worstAfterMs<=bestBeforeMs},numericalPayrollCalculationClaim:false},null,2));
},600000);
