/**
 * Reader/writer Access lock, payroll wave. Real PostgreSQL through the repository harness.
 *
 * The payroll writers (salary, MY statutory, fixed items, payroll inputs, loans) and the payroll lifecycle
 * owners now run under the SHARED Access lock. Exclusivity used to be the only thing keeping a change out
 * of an in-flight run; these cases hold real transactions open on separate connections to show what
 * replaces it: the run either includes a change or is marked for recalculation, a payroll input written
 * during processing is refused rather than lost, a loan balance is never read-modified-written twice, and
 * no converted path ever asks for the exclusive lock (strict mode, plus a foreign shared holder that would
 * make any exclusive request wait and fail).
 */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,asc,eq} from 'drizzle-orm';
import {sql as dsql} from 'drizzle-orm';
import postgres from 'postgres';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {BatchNotDraftError,createBatch,generatePayslips,resetProcessedBatch,setPayrollInput} from '../core/payroll';
import {amendLoan,applyLoansForBatch,createLoan,prefillLoansForBatch} from '../core/loans';
import {listPayComponents,seedPayComponentCatalog,setEmploymentPayComponent} from '../core/pay-components';
import {lockNativePayrollPeriodsTx} from '../core/payroll-period-lock';
import {lockPayComponentCatalogReadTx,lockPayComponentCatalogTx} from '../core/pay-component-catalog-lock';
import {lockPayrollInputsTx} from '../core/payroll-inputs-lock';
import {lockStatutorySourceTx} from '../core/statutory-source-lock';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,setSetting,type Base} from './harness';

const barrier=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};};
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function settled<T>(promise:Promise<T>,ms=4000):Promise<'timeout'|{value:T}>{
 let timer:ReturnType<typeof setTimeout>|undefined;
 try{return await Promise.race([promise.then(value=>({value})),new Promise<'timeout'>(resolve=>{timer=setTimeout(()=>resolve('timeout'),ms);})]);}
 finally{if(timer)clearTimeout(timer);}
}
const sqlState=(reason:unknown)=>{
 let current=reason as {code?:unknown;cause?:unknown}|undefined;
 for(let depth=0;current&&depth<6;depth++){if(typeof current.code==='string')return current.code;current=current.cause as typeof current;}
 return undefined;
};
const accessKey=(tenantId:string)=>`hashtextextended('access-configuration:${tenantId}',0)`;
const inputsKey=(tenantId:string,companyId:string)=>`hashtextextended('payroll-inputs:${tenantId}:${companyId}',0)`;

let b:Base;
let raw:postgres.Sql;
let strictBefore:string|undefined;
beforeAll(async()=>{await migrateTestDb();raw=postgres(process.env.TEST_MIGRATION_DATABASE_URL!,{max:16,onnotice:()=>{}});strictBefore=process.env.AIHR_ACCESS_LOCK_STRICT;});
/** Strict mode for the converted paths under test only: fixtures hire through other areas' writers. */
async function strictly<T>(work:()=>Promise<T>):Promise<T>{
 process.env.AIHR_ACCESS_LOCK_STRICT='on';
 try{return await work();}finally{if(strictBefore===undefined)delete process.env.AIHR_ACCESS_LOCK_STRICT;else process.env.AIHR_ACCESS_LOCK_STRICT=strictBefore;}
}
beforeEach(async()=>{await resetDb();b=await seedBase();for(const module of ['payroll','typed_pay_components'])await setModule(b.tenantId,module,'active');await setSetting(b.tenantId,'payroll.reset_enabled',true);});
afterAll(async()=>{await raw.end({timeout:5});await closeAll();});

let icSequence=0;
async function worker(label:string,basic:number){
 const admin=adminCtx(b);
 const e=await hireEmployee(admin,{person:{fullName:`Fictional ${label}`,primaryEmail:`fictional-${label.toLowerCase().replace(/\s+/g,'-')}-${icSequence}@payroll-rw.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
 await setCompensation(admin,{employmentId:e.employmentId,basicSalary:basic,monthlyAllowance:0,effectiveFrom:'2026-01-01'});
 await setStatutoryProfileMY(admin,{personId:e.personId,icNumber:`9001011${String(40000+icSequence++).slice(-5)}`});
 return e;
}
/** A foreign transaction that holds the payroll batch row, so a run blocks right after taking its locks. */
function holdBatchRow(batchId:string){
 const held=barrier(),release=barrier();
 const done=raw.begin(async tx=>{await tx.unsafe(`select 1 from payroll_batch where id='${batchId}' for share`);held.resolve();await release.promise;});
 return {held:held.promise,release:release.resolve,done};
}
async function waitForInputsHolder(companyId:string){
 for(let attempt=0;attempt<100;attempt++){
  const [row]=await raw.unsafe(`select exists(select 1 from pg_locks where locktype='advisory' and granted and mode='ExclusiveLock' and objsubid=1 and ((classid::bigint<<32)|objid::bigint)=${inputsKey(b.tenantId,companyId)}) as held`);
  if(row.held)return;
  await pause(50);
 }
 throw new Error('The run never took the payroll inputs key');
}
const batchMark=async(batchId:string)=>{const [row]=await owner.db.select({status:schema.payrollBatch.status,at:schema.payrollBatch.needsRecalcAt,ids:schema.payrollBatch.recalcEmploymentIds}).from(schema.payrollBatch).where(eq(schema.payrollBatch.id,batchId));return row;};
const slipOf=async(batchId:string,employmentId:string)=>{const [row]=await owner.db.select().from(schema.payslip).where(and(eq(schema.payslip.batchId,batchId),eq(schema.payslip.employmentId,employmentId)));return row;};
const heldModes=async(tx:Parameters<Parameters<typeof withTenant>[1]>[0],companyId:string)=>{
 const [row]=await tx.execute<{access:string|null;inputs:string|null}>(dsql`select app.access_lock_mode_held(${b.tenantId}::uuid) as access,
  (select string_agg(mode,',' order by mode) from pg_locks where locktype='advisory' and pid=pg_backend_pid() and granted and objsubid=1
   and ((classid::bigint<<32)|objid::bigint)=hashtextextended(${'payroll-inputs:'+b.tenantId+':'+companyId},0)) as inputs`);
 return row;
};

describe('payroll wave: lock modes',()=>{
 it('runs a payroll lifecycle owner under the shared Access lock with its company inputs key exclusive',async()=>{
  const a=await entitledCtx(b);
  await withTenant(a,async tx=>{
   await lockNativePayrollPeriodsTx(tx,a,[{companyId:b.companyId,payPeriod:'2026-05'}]);
   expect(await heldModes(tx,b.companyId)).toEqual({access:'S',inputs:'ExclusiveLock'});
  });
 });
 it('joins input writers in shared mode, and they overlap each other',async()=>{
  const e=await worker('Overlap',3000);
  const both=[barrier(),barrier()],go=barrier();
  const inputs=both.map(entry=>withTenant(adminCtx(b),async tx=>{await lockPayrollInputsTx(tx,{employmentIds:[e.employmentId]});const modes=await heldModes(tx,b.companyId);entry.resolve();await go.promise;return modes;}));
  await expect(settled(Promise.all(both.map(entry=>entry.promise)))).resolves.not.toBe('timeout');
  go.resolve();
  expect(await Promise.all(inputs)).toEqual([{access:null,inputs:'ShareLock'},{access:null,inputs:'ShareLock'}]);
 },30000);
 it('splits the pay component catalogue lock into a shared reader and an exclusive editor',async()=>{
  const a=adminCtx(b);
  await withTenant(a,async tx=>{await lockPayComponentCatalogReadTx(tx,a);expect((await heldModes(tx,b.companyId)).access).toBe('S');});
  await withTenant(a,async tx=>{await lockPayComponentCatalogTx(tx,a);expect((await heldModes(tx,b.companyId)).access).toBe('X');});
 });
});

describe('payroll wave: no converted path asks for the exclusive lock',()=>{
 it('completes the payroll inputs and the whole run lifecycle while another session holds the shared Access lock',async()=>{
  const admin=adminCtx(b),a=await entitledCtx(b);
  const loaned=await worker('Ledger',3600),other=await worker('Other',5100);
  await seedPayComponentCatalog(admin);
  const allowance=(await listPayComponents(admin)).find(c=>c.code==='ALLOWANCE');
  if(!allowance)throw new Error('Missing native ALLOWANCE item');
  const loan=await createLoan(a,{employmentId:loaned.employmentId,loanType:'personal',principal:1200,interestRate:0,interestMethod:'none',durationMonths:6,startDate:'2026-01-01'});
  const held=barrier(),release=barrier();
  const reader=raw.begin(async tx=>{await tx.unsafe(`select pg_advisory_xact_lock_shared(${accessKey(b.tenantId)})`);held.resolve();await release.promise;});
  await held.promise;
  const step=async<T>(label:string,work:()=>Promise<T>)=>{
   const outcome=await settled(work().catch(error=>({failed:`${label}: ${sqlState(error)??''} ${error instanceof Error?error.message:String(error)}`})),30000);
   expect(outcome,label).not.toBe('timeout');
   const value=(outcome as {value:unknown}).value as {failed?:string}|undefined;
   expect(value?.failed,label).toBeUndefined();
   return value as unknown as T;
  };
  try{await strictly(async()=>{
   await step('salary',()=>setCompensation(admin,{employmentId:other.employmentId,basicSalary:5300,effectiveFrom:'2026-04-01'}));
   await step('statutory',()=>setStatutoryProfileMY(admin,{personId:other.personId,icNumber:'900101144499',employerBearsEis:true}));
   await step('fixed item',()=>setEmploymentPayComponent(a,{employmentId:other.employmentId,componentId:allowance.id,amount:150,effectiveFrom:'2026-01-01'}));
   const {batchId}=await step('create',()=>createBatch(a,{companyId:b.companyId,payPeriod:'2026-05'}));
   await step('loan prefill',()=>prefillLoansForBatch(a,{batchId}));
   await step('bonus input',()=>setPayrollInput(a,{batchId,employmentId:other.employmentId,overtimeAmount:0,bonusAmount:400}));
   await step('process',()=>generatePayslips(a,{batchId}));
   await step('reset',()=>resetProcessedBatch(a,{batchId,reason:'Fictional reader writer reset'}));
   await step('process again',()=>generatePayslips(a,{batchId}));
   await step('loan amend',()=>amendLoan(a,{loanId:loan.id,durationMonths:8}));
  });}finally{release.resolve();await reader;}
 },180000);
});

describe('(M) compensation against an in-flight payroll run',()=>{
 it('includes a salary change that committed before the run read its inputs',async()=>{
  const admin=adminCtx(b),a=await entitledCtx(b);
  const e=await worker('Before',4000);
  const {batchId}=await createBatch(a,{companyId:b.companyId,payPeriod:'2026-05'});
  const entered=barrier(),release=barrier();
  const change=withTenant(admin,async tx=>{await setCompensation(admin,{employmentId:e.employmentId,basicSalary:4500,effectiveFrom:'2026-05-01'},tx);entered.resolve();await release.promise;});
  await entered.promise;
  const run=generatePayslips(a,{batchId});
  expect(await settled(run,800)).toBe('timeout');
  release.resolve();await change;await run;
  expect((await slipOf(batchId,e.employmentId)).basicSalary).toBe('4500.00');
  expect((await batchMark(batchId)).at).toBeNull();
 },90000);
 it('makes a change during the run wait for it, then marks the processed run for recalculation',async()=>{
  const admin=adminCtx(b),a=await entitledCtx(b);
  const e=await worker('During',4000);
  const {batchId}=await createBatch(a,{companyId:b.companyId,payPeriod:'2026-05'});
  const hold=holdBatchRow(batchId);await hold.held;
  await strictly(async()=>{
   const run=generatePayslips(a,{batchId});
   await waitForInputsHolder(b.companyId);
   const change=setCompensation(admin,{employmentId:e.employmentId,basicSalary:4500,effectiveFrom:'2026-05-01'});
   expect(await settled(change,800)).toBe('timeout');
   hold.release();await hold.done;await run;await change;
  });
  expect((await slipOf(batchId,e.employmentId)).basicSalary).toBe('4000.00');
  const mark=await batchMark(batchId);
  expect(mark.status).toBe('processed');
  expect(mark.at).not.toBeNull();
  expect(mark.ids).toEqual([e.employmentId]);
 },90000);
 it('marks the run the same way for an MY statutory change made during processing',async()=>{
  const admin=adminCtx(b),a=await entitledCtx(b);
  const e=await worker('Statutory',4200);
  const [stat]=await owner.db.select({ic:schema.employeeStatutoryMy.icNumber}).from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.personId,e.personId));
  const {batchId}=await createBatch(a,{companyId:b.companyId,payPeriod:'2026-05'});
  const hold=holdBatchRow(batchId);await hold.held;
  const run=generatePayslips(a,{batchId});
  await waitForInputsHolder(b.companyId);
  const change=setStatutoryProfileMY(admin,{personId:e.personId,icNumber:stat.ic,employerBearsEis:true});
  expect(await settled(change,800)).toBe('timeout');
  hold.release();await hold.done;await run;await change;
  const mark=await batchMark(batchId);
  expect(mark.at).not.toBeNull();
  expect(mark.ids).toEqual([e.employmentId]);
 },90000);
});

describe('(M) bonus payroll input against a running process',()=>{
 // The payroll-input bonus is paid on the classic earnings path; the typed item path pays from items.
 beforeEach(async()=>{await setModule(b.tenantId,'typed_pay_components',null);});
 it('refuses a bonus written while the run is processing instead of losing it',async()=>{
  const a=await entitledCtx(b);
  const e=await worker('Bonus',3900);
  const {batchId}=await createBatch(a,{companyId:b.companyId,payPeriod:'2026-05'});
  const hold=holdBatchRow(batchId);await hold.held;
  const run=generatePayslips(a,{batchId});
  await waitForInputsHolder(b.companyId);
  const bonus=setPayrollInput(a,{batchId,employmentId:e.employmentId,overtimeAmount:0,bonusAmount:800});
  expect(await settled(bonus.catch(()=>undefined),800)).toBe('timeout');
  hold.release();await hold.done;await run;
  await expect(bonus).rejects.toBeInstanceOf(BatchNotDraftError);
  expect((await slipOf(batchId,e.employmentId)).bonus).toBe('0.00');
  const inputs=await owner.db.select().from(schema.payrollInput).where(and(eq(schema.payrollInput.batchId,batchId),eq(schema.payrollInput.employmentId,e.employmentId)));
  expect(inputs.map(row=>row.bonusAmount)).not.toContain('800.00');
 },90000);
 it('lets a bonus written before processing reach the payslip',async()=>{
  const a=await entitledCtx(b);
  const e=await worker('Early bonus',3900);
  const {batchId}=await createBatch(a,{companyId:b.companyId,payPeriod:'2026-05'});
  const entered=barrier(),release=barrier();
  const bonus=withTenant(a,async tx=>{await setPayrollInput(a,{batchId,employmentId:e.employmentId,overtimeAmount:0,bonusAmount:800},tx);entered.resolve();await release.promise;});
  await entered.promise;
  const run=generatePayslips(a,{batchId});
  expect(await settled(run,800)).toBe('timeout');
  release.resolve();await bonus;await run;
  expect((await slipOf(batchId,e.employmentId)).bonus).toBe('800.00');
 },90000);
});

describe('(M) loan balance read-modify-write',()=>{
 async function reservedLoan(label:string){
  const a=await entitledCtx(b);
  const e=await worker(label,3600);
  const loan=await createLoan(a,{employmentId:e.employmentId,loanType:'personal',principal:1200,interestRate:0,interestMethod:'none',durationMonths:6,startDate:'2026-01-01'});
  const {batchId}=await createBatch(a,{companyId:b.companyId,payPeriod:'2026-05'});
  await prefillLoansForBatch(a,{batchId});
  return {a,e,loan,batchId};
 }
 const ledger=async(loanId:string)=>{
  const [loan]=await owner.db.select({outstanding:schema.employeeLoan.outstandingBalance,paid:schema.employeeLoan.instalmentsPaid}).from(schema.employeeLoan).where(eq(schema.employeeLoan.id,loanId));
  const schedule=await owner.db.select({due:schema.loanRepayment.dueAmount,status:schema.loanRepayment.status,applied:schema.loanRepayment.appliedAmount}).from(schema.loanRepayment).where(eq(schema.loanRepayment.loanId,loanId)).orderBy(asc(schema.loanRepayment.sequenceNo));
  return {loan,schedule};
 };
 it('applies one instalment once when two repayments of it race',async()=>{
  const {a,e,loan,batchId}=await reservedLoan('Race');
  const entered=barrier(),release=barrier();
  const budget=()=>new Map([[e.employmentId,20000]]);
  const first=withTenant(a,async tx=>{await applyLoansForBatch(tx,a,batchId,budget());entered.resolve();await release.promise;});
  await entered.promise;
  const second=withTenant(a,tx=>applyLoansForBatch(tx,a,batchId,budget()));
  expect(await settled(second,800)).toBe('timeout');
  release.resolve();await first;await second;
  const after=await ledger(loan.id);
  expect(after.loan).toEqual({outstanding:'1000.00',paid:1});
  expect(after.schedule.filter(row=>row.status==='applied')).toEqual([{due:'200.00',status:'applied',applied:'200.00'}]);
 },90000);
 it('re-plans an amended schedule from the balance a concurrent repayment left, never a stale one',async()=>{
  const {a,e,loan,batchId}=await reservedLoan('Amend');
  const entered=barrier(),release=barrier();
  const repayment=withTenant(a,async tx=>{await applyLoansForBatch(tx,a,batchId,new Map([[e.employmentId,20000]]));entered.resolve();await release.promise;});
  await entered.promise;
  // Without the row lock the amendment would re-plan 1200.00 over three months from a stale balance.
  const amend=amendLoan(a,{loanId:loan.id,durationMonths:3});
  expect(await settled(amend,800)).toBe('timeout');
  release.resolve();await repayment;await amend;
  const after=await ledger(loan.id);
  expect(after.loan).toEqual({outstanding:'1000.00',paid:1});
  const scheduledCents=after.schedule.filter(row=>row.status==='scheduled').reduce((sum,row)=>sum+Math.round(Number(row.due)*100),0);
  expect(scheduledCents).toBe(100000);
 },90000);
});

describe('(M) MY statutory setters under the shared lock',()=>{
 it('lets statutory writers for different people overlap and does not refuse them while a leave writer holds the dependency configuration',async()=>{
  const [first,second]=[await worker('Stat one',3000),await worker('Stat two',3000)];
  const held=barrier(),release=barrier();
  const leave=raw.begin(async tx=>{await tx.unsafe(`select pg_advisory_xact_lock_shared(${accessKey(b.tenantId)})`);await tx.unsafe(`select pg_advisory_xact_lock_shared(hashtextextended('leave-dependency-configuration:${b.tenantId}',0))`);held.resolve();await release.promise;});
  await held.promise;
  const entered=[barrier(),barrier()],go=barrier();
  const writers=[first,second].map((e,index)=>withTenant(adminCtx(b),async tx=>{await lockStatutorySourceTx(tx,adminCtx(b),{personId:e.personId});entered[index].resolve();await go.promise;}));
  await expect(settled(Promise.all(entered.map(entry=>entry.promise)))).resolves.not.toBe('timeout');
  go.resolve();await Promise.all(writers);release.resolve();await leave;
 },60000);
 it('serialises two writers of one person on the statutory subject key',async()=>{
  const e=await worker('Same person',3000);
  const entered=barrier(),release=barrier();
  const one=withTenant(adminCtx(b),async tx=>{await lockStatutorySourceTx(tx,adminCtx(b),{personId:e.personId});entered.resolve();await release.promise;});
  await entered.promise;
  const two=withTenant(adminCtx(b),tx=>lockStatutorySourceTx(tx,adminCtx(b),{personId:e.personId}));
  expect(await settled(two,600)).toBe('timeout');
  release.resolve();await one;await two;
 },60000);
 it('keeps the subject-less operator interval exclusive',async()=>{
  const ctx:SessionContext=adminCtx(b);
  await withTenant(ctx,async tx=>{await lockStatutorySourceTx(tx,ctx);expect((await heldModes(tx,b.companyId)).access).toBe('X');});
 });
});
