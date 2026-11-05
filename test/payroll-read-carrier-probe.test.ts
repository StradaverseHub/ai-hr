/** Reversible native observation, not a product lock/transaction conversion. */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {and,eq,gt,inArray,isNull,or,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {createBatch,listBatches,payrollDashboardCounts,payrollCloseCompanyIds} from '../core/payroll';
import {getPayrollConfig,listPayrollConfigs,setPayrollConfig} from '../core/payroll-config';
import {listPayrollCycles,seedPayrollCycleCatalog} from '../core/payroll-cycle';
import {listCompanies,listDepartments,listJobGrades} from '../core/read';
import {lockAccessConfigurationTx} from '../core/access-configuration-lock';
import {lockPayrollHistoryReadTx,lockPayrollHistoryWriteTx} from '../core/payroll-history-lock';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,ctx:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();ctx=adminCtx(b);await seedPayrollCycleCatalog(ctx,b.companyId);await setPayrollConfig(ctx,{companyId:b.companyId,payDay:25});await createBatch(ctx,{companyId:b.companyId,payPeriod:'2020-01'});});
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function barrier(kind:'access'|'history'){
 let release!:()=>void,entered!:()=>void;
 const opened=new Promise<void>(resolve=>{entered=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
 const job=withTenant(ctx,async tx=>{if(kind==='access')await lockAccessConfigurationTx(tx,b.tenantId);else await lockPayrollHistoryWriteTx(tx,b.tenantId);entered();await hold;});
 await opened;return{release,job};
}
it('observes actual public Payroll readers under AccessX without changing any lock owner',async()=>{
 const readers=[['batches',()=>listBatches(ctx,[b.companyId])],['counts',()=>payrollDashboardCounts(ctx,[b.companyId])],['config',()=>getPayrollConfig(ctx,b.companyId)],['configs',()=>listPayrollConfigs(ctx,[b.companyId])],['cycles',()=>listPayrollCycles(ctx,b.companyId)],['closeCompanies',()=>payrollCloseCompanyIds(ctx,[b.companyId])]] as const;
 const expected=await Promise.all(readers.map(([,read])=>read())),held=await barrier('access'),receipts:{reader:string;elapsedMs:number;overlapsAccessX:boolean}[]=[],pending:Promise<unknown>[]=[];
 try{for(let i=0;i<readers.length;i++){const [name,read]=readers[i],start=performance.now(),reading=read();pending.push(reading);const result=await Promise.race([reading.then(value=>({done:true as const,value})),delay(1500).then(()=>({done:false as const}))]);receipts.push({reader:name,elapsedMs:performance.now()-start,overlapsAccessX:result.done});if(result.done)expect(result.value).toEqual(expected[i]);}}
 finally{held.release();await held.job;await Promise.allSettled(pending);if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'payroll-default-read-carriers.json'),JSON.stringify({kind:'ACTUAL_DEFAULT_READER_ACCESS_BARRIER_PROBE',releaseEligible:false,receipts,applicationChanges:false},null,2));}
 expect(receipts.every(row=>row.overlapsAccessX)).toBe(true);
});
it('retains native History writer exclusion for actual list and count readers',async()=>{
 const expected=await payrollDashboardCounts(ctx,[b.companyId]),held=await barrier('history');let listSettled=false,countSettled=false;
 const listing=listBatches(ctx,[b.companyId]).then(rows=>{listSettled=true;return rows;}),counting=payrollDashboardCounts(ctx,[b.companyId]).then(rows=>{countSettled=true;return rows;});
 try{await delay(150);expect(listSettled).toBe(false);expect(countSettled).toBe(false);}finally{held.release();await held.job;}
 expect(await listing).toHaveLength(expected.totalCount);expect(await counting).toEqual(expected);
});
it('proves selected native READ ONLY bodies and setup seams are eligible, without adopting a new carrier',async()=>{
 const baseline={counts:await payrollDashboardCounts(ctx,[b.companyId]),companies:await listCompanies(ctx),departments:await listDepartments(ctx,{companyIds:[b.companyId]}),grades:await listJobGrades(ctx)};
 const observed=await withTenant(ctx,async tx=>{
  await tx.execute(sql`set transaction read only`);await lockPayrollHistoryReadTx(tx,b.tenantId);
  const [counts]=await tx.select({totalCount:sql<number>`count(*)`.mapWith(Number),unpublishedCount:sql<number>`count(*) filter(where ${s.payrollBatch.historyImportAttemptId} is null and ${s.payrollBatch.status} not in ('draft','closed'))`.mapWith(Number)}).from(s.payrollHistoryEffectiveBatch).innerJoin(s.company,eq(s.company.id,s.payrollBatch.companyId)).leftJoin(s.payrollCycle,eq(s.payrollCycle.id,s.payrollBatch.payrollCycleId)).where(and(inArray(s.payrollBatch.companyId,[b.companyId]),or(isNull(s.payrollBatch.historyImportAttemptId),gt(s.payrollBatch.employeeCount,0))));
  return{counts,companies:await listCompanies(ctx,{},tx),departments:await listDepartments(ctx,{companyIds:[b.companyId]},tx),grades:await listJobGrades(ctx,{},tx)};
 });
 expect(observed).toEqual(baseline);
 await expect(withTenant(ctx,async tx=>{await tx.execute(sql`set transaction read only`);await tx.update(s.company).set({legalName:'FORBIDDEN_PROBE_WRITE'}).where(eq(s.company.id,b.companyId));})).rejects.toMatchObject({cause:{code:'25006'}});
 expect((await owner.db.select({name:s.company.legalName}).from(s.company).where(eq(s.company.id,b.companyId)))[0].name).not.toBe('FORBIDDEN_PROBE_WRITE');
});
