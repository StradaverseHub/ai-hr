/** Authored UNRUN: actual canonical Payroll runs and two-connection period interleavings.
 * Static source is not runtime/concurrency/security proof. No provider or production data. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {client,withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {requirePackFor} from '../localization/registry';
import {createBatch,createAdditionalRun,generatePayslips,closeBatch,setPayrollInput,seedPayrollCycleCatalog,createPayComponent} from '../packs/payroll/service';
import {commitPayrollHistoryImport} from '../core/payroll-history-import';
import {PAYROLL_HISTORY_HEADERS} from '../lib/payroll-history-import-schema';
import {parseCsvRecords} from '../lib/csv';
import {lockPayrollPeriodsTx,payrollPeriodOwnerKey,PayrollPeriodOwnershipUnavailable} from '../core/payroll-period-lock';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base,ctx:SessionContext,period:string,otherPeriod:string,employmentId:string;
const month=(offset:number)=>{const [y,m]=todayInKualaLumpur().split('-').map(Number);return new Date(Date.UTC(y,m-1+offset,1)).toISOString().slice(0,7);};
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'multi_cycle_payroll','active');ctx={...await entitledCtx(b,['hr_admin']),grants:[{role:'hr_admin',companyId:null}]};period=month(-1);otherPeriod=month(-2);const hiredOn=String(Number(otherPeriod.slice(0,4))-1)+'-01-01',e=await hireEmployee(ctx,{person:{fullName:'Fictional period employee',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employeeCode:'FIC001',employmentType:'full_time',hiredOn});employmentId=e.employmentId;await setCompensation(ctx,{employmentId,basicSalary:5000,effectiveFrom:hiredOn});await requirePackFor('MY').statutory.set(ctx,{personId:e.personId,icNumber:'900101019665'});});
async function batch(type:'regular'|'bonus'='regular'){const r=type==='regular'?await createBatch(ctx,{companyId:b.companyId,payPeriod:period}):await createAdditionalRun(ctx,{companyId:b.companyId,payPeriod:period,runType:'bonus'});if(type==='bonus')await setPayrollInput(ctx,{batchId:r.batchId,employmentId,overtimeAmount:0,bonusAmount:100});await generatePayslips(ctx,{batchId:r.batchId});return r.batchId;}
async function state(){return{periods:await owner.db.select().from(s.payPeriod).where(eq(s.payPeriod.tenantId,b.tenantId)).orderBy(s.payPeriod.id),batches:await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.tenantId,b.tenantId)).orderBy(s.payrollBatch.id),slips:await owner.db.select().from(s.payslip).where(eq(s.payslip.tenantId,b.tenantId)).orderBy(s.payslip.id),events:await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(s.domainEvent.id)};}
async function waitingOn(pid:number){for(let n=0;n<100;n++){const [row]=await owner.db.execute<{pid:number}>(sql`select a.pid from pg_stat_activity a where ${pid}=any(pg_blocking_pids(a.pid)) and a.pid<>pg_backend_pid() order by a.pid limit 1`);if(row)return row.pid;await new Promise(yes=>setTimeout(yes,10));}throw Error('Actual expected database wait not observed');}
async function holdRow(kind:'batch'|'period',id:string){let ready!:(pid:number)=>void,release!:()=>void;const start=new Promise<number>(yes=>{ready=yes;}),finish=new Promise<void>(yes=>{release=yes;}),running=owner.db.transaction(async tx=>{const [row]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);if(kind==='batch')await tx.select({id:s.payrollBatch.id}).from(s.payrollBatch).where(eq(s.payrollBatch.id,id)).for('update');else await tx.select({id:s.payPeriod.id}).from(s.payPeriod).where(eq(s.payPeriod.id,id)).for('update');ready(row.pid);await finish;});return{pid:await start,release,done:running};}
// Observe the actual PostgreSQL try result, preserving the transaction and driver's normal query path.
// 7b6dceb82 moved Close onto the shared Access lock (a shared try) and, with it, the point where a same
// company/month close meets another owner: the period owner key, tried without waiting. Both are admission
// misses; any other key is not.
function observeCloseAccessMisses(){
 const begin=client.begin.bind(client),accessKey='access-configuration:'+b.tenantId,periodKeyPrefix='payroll-period:';
 let misses=0;
 const spy=vi.spyOn(client,'begin').mockImplementation(((...args:unknown[])=>{
  const index=args.findIndex(value=>typeof value==='function');
  const callback=args[index] as (native:typeof client)=>unknown;
  let missed=false;
  args[index]=(native:typeof client)=>callback(new Proxy(native,{get(target,key,receiver){
   if(key==='unsafe')return (...query:unknown[])=>{
    const pending=Reflect.apply(target.unsafe,target,query);
    if(typeof query[0]==='string'&&/pg_try_advisory_xact_lock(?:_shared)?\(/.test(query[0])&&Array.isArray(query[1])
     &&query[1].some(value=>value===accessKey||typeof value==='string'&&value.startsWith(periodKeyPrefix)&&value.includes(b.tenantId))){
     void (pending as PromiseLike<readonly {acquired?:boolean;owned?:boolean}[]>).then(rows=>{
      if(rows[0]?.acquired===false||rows[0]?.owned===false)missed=true;
     },()=>undefined);
    }
    return pending;
   };
   return Reflect.get(target,key,receiver);
  }}));
  const transaction=Reflect.apply(begin,client,args) as PromiseLike<unknown>;
  const settled=()=>{if(missed)misses++;};
  void transaction.then(settled,()=>undefined);
  return transaction;
 }) as typeof client.begin);
 return {misses:()=>misses,restore:()=>spy.mockRestore()};
}

async function expectNoNativeWaiter(pid:number){
 const [probe]=await owner.db.execute<{blocked:boolean}>(sql`select exists(
  select 1 from pg_stat_activity a where a.pid<>pg_backend_pid() and ${pid}=any(pg_blocking_pids(a.pid))
 ) as blocked`);
 expect(probe.blocked).toBe(false);
}

async function expectCooperativeAdmission(probe:ReturnType<typeof observeCloseAccessMisses>,ownerPid:number){
 for(const completedMisses of [1,2]){
  await expect.poll(probe.misses,{timeout:2000,interval:10}).toBeGreaterThanOrEqual(completedMisses);
  await expectNoNativeWaiter(ownerPid);
 }
}

async function scopedCloser(companyId:string){
 const userId=await createAppUser(b.tenantId,null,'hr_admin');
 await owner.db.update(s.roleAssignment).set({companyId}).where(eq(s.roleAssignment.appUserId,userId));
 return {...ctx,userId,grants:[{role:'hr_admin',companyId}]} satisfies SessionContext;
}

describe('canonical same company/month owner',()=>{
 it('two actual sibling closes serialize before status facts and close their parent exactly once',async()=>{
  const first=await batch(),second=await batch('bonus'),before=await state(),holder=await holdRow('batch',first);
  const firstClose=closeBatch(ctx,{batchId:first});void firstClose.catch(()=>undefined);
  const probe=observeCloseAccessMisses();
  let secondClose:ReturnType<typeof closeBatch>|undefined;
  try{
   const firstPid=await waitingOn(holder.pid);
   secondClose=closeBatch(ctx,{batchId:second});void secondClose.catch(()=>undefined);
   await expectCooperativeAdmission(probe,firstPid);
   expect(await state()).toEqual(before);
  }finally{
   try{holder.release();await holder.done;}
   finally{await Promise.allSettled([firstClose,secondClose]);probe.restore();}
  }
  await firstClose;await secondClose;
  const after=await state(),parent=after.periods.find(row=>row.period===period)!;
  expect(after.batches.filter(row=>[first,second].includes(row.id)).map(row=>row.status)).toEqual(['closed','closed']);
  expect(parent.status).toBe('closed');
  const events=after.events.filter(event=>!before.events.some(old=>old.id===event.id));
  expect(events.filter(e=>e.eventType==='pay-period.closed'&&e.aggregateId===parent.id)).toHaveLength(1);
  expect(events.filter(e=>e.eventType==='payroll-batch.closed')).toHaveLength(2);
 });

 it.each(['close','create'] as const)('%s wins explicit additional-run interleaving without phantom membership or a draft under a closed parent',async winner=>{
  const first=await batch(),before=await state(),parent=before.periods.find(row=>row.period===period)!;
  const holder=await holdRow(winner==='close'?'batch':'period',winner==='close'?first:parent.id);
  const close=()=>closeBatch(ctx,{batchId:first}),create=()=>createAdditionalRun(ctx,{companyId:b.companyId,payPeriod:period,runType:'bonus'});
  const firstCommand=winner==='close'?close():create();void firstCommand.catch(()=>undefined);
  const probe=observeCloseAccessMisses();
  let second:Promise<unknown>|undefined;
  try{
   const firstPid=await waitingOn(holder.pid);
   second=winner==='close'?create():close();void second.catch(()=>undefined);
   if(winner==='close')await waitingOn(firstPid); // Additional-run writer still waits on canonical Access.
   else await expectCooperativeAdmission(probe,firstPid);
   expect(await state()).toEqual(before);
  }finally{
   try{holder.release();await holder.done;}
   finally{await Promise.allSettled([firstCommand,second]);probe.restore();}
  }
  const outcomes=await Promise.allSettled([firstCommand,second!]),after=await state();
  const runs=after.batches.filter(row=>row.payPeriod===period),month=after.periods.find(row=>row.id===parent.id)!;
  expect(outcomes[0].status).toBe('fulfilled');
  if(winner==='close'){
   expect(outcomes[1].status).toBe('rejected');expect(month.status).toBe('closed');expect(runs).toHaveLength(1);
  }else{
   expect(outcomes[1].status).toBe('fulfilled');expect(month.status).toBe('open');expect(runs).toHaveLength(2);
   expect(runs.find(row=>row.id!==first)?.status).toBe('draft');
  }
  expect(runs.find(row=>row.id===first)?.status).toBe('closed');
 });

 it('cooperatively admits two real same-tenant scoped company closes and publishes each exactly once',async()=>{
  const [company]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional second Payroll company',country:'MY'}).returning();
  const [dept]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:company.id,name:'Fictional Payroll department'}).returning();
  const hiredOn=String(Number(otherPeriod.slice(0,4))-1)+'-01-01';
  const employee=await hireEmployee(ctx,{person:{fullName:'Fictional second company employee',primaryEmail:randomUUID()+'@fixture.test'},
   companyId:company.id,departmentId:dept.id,employeeCode:'FIC002',employmentType:'full_time',hiredOn});
  await setCompensation(ctx,{employmentId:employee.employmentId,basicSalary:5000,effectiveFrom:hiredOn});
  await requirePackFor('MY').statutory.set(ctx,{personId:employee.personId,icNumber:'900101019776'});
  const first=await batch(),{batchId:second}=await createBatch(ctx,{companyId:company.id,payPeriod:period});
  await generatePayslips(ctx,{batchId:second});
  const firstActor=await scopedCloser(b.companyId),secondActor=await scopedCloser(company.id),before=await state();
  await expect(closeBatch(firstActor,{batchId:second})).rejects.toThrow();
  expect(await state()).toEqual(before);

  const holder=await holdRow('batch',first);
  const firstClose=closeBatch(firstActor,{batchId:first});void firstClose.catch(()=>undefined);
  const probe=observeCloseAccessMisses();
  let secondClose:ReturnType<typeof closeBatch>|undefined;
  try{
   const firstPid=await waitingOn(holder.pid);
   // 7b6dceb82: under the shared Access lock, Payroll runs of different companies overlap. The other company's
   // close neither waits behind the held one nor misses: it commits while the first is still held.
   secondClose=closeBatch(secondActor,{batchId:second});void secondClose.catch(()=>undefined);
   await secondClose;
   expect(probe.misses()).toBe(0);await expectNoNativeWaiter(firstPid);
   const during=await state();
   expect(during.batches.find(row=>row.id===first)).toEqual(before.batches.find(row=>row.id===first));
   expect(during.batches.find(row=>row.id===second)?.status).toBe('closed');
   expect(during.slips).toEqual(before.slips);
  }finally{
   try{holder.release();await holder.done;}
   finally{await Promise.allSettled([firstClose,secondClose]);probe.restore();}
  }
  await firstClose;await secondClose;

  const after=await state(),events=after.events.filter(event=>!before.events.some(old=>old.id===event.id));
  expect(after.slips).toEqual(before.slips);
  for(const [batchId,actor]of [[first,firstActor],[second,secondActor]] as const){
   const run=after.batches.find(row=>row.id===batchId)!;
   const parent=after.periods.find(row=>row.id===run.payPeriodId);
   expect(run.status).toBe('closed');expect(run.releasedAt).not.toBeNull();expect(parent?.status).toBe('closed');
   expect(events.filter(event=>event.aggregateId===batchId&&event.eventType==='payroll-batch.closed'))
    .toMatchObject([{actorId:actor.userId,payload:{companyId:run.companyId}}]);
   expect(events.filter(event=>event.aggregateId===run.payPeriodId&&event.eventType==='pay-period.closed'))
    .toMatchObject([{actorId:actor.userId}]);
  }
 });
 it('checks current login authority again after a real admission miss and leaves no close effect',async()=>{
  const run=await batch(),actor=await scopedCloser(b.companyId),before=await state();
  let ready!:(pid:number)=>void,release!:()=>void;
  const entered=new Promise<number>(resolve=>{ready=resolve;}),finish=new Promise<void>(resolve=>{release=resolve;});
  const hold=owner.db.transaction(async tx=>{
   await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`);
   const [ownerPid]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);
   ready(ownerPid.pid);await finish;
   await tx.update(s.appUser).set({archivedAt:new Date()}).where(eq(s.appUser.id,actor.userId));
  });
  const pid=await Promise.race([entered,hold.then(()=>{throw Error('Access holder ended before observation');})]);
  const probe=observeCloseAccessMisses(),close=closeBatch(actor,{batchId:run});
  void close.catch(()=>undefined);
  try{
   await expectCooperativeAdmission(probe,pid);
   expect(await state()).toEqual(before);
  }finally{
   try{release();await hold;}
   finally{await Promise.allSettled([close]);probe.restore();}
  }
  await expect(close).rejects.toBeInstanceOf(PayrollPeriodOwnershipUnavailable);
  expect(await state()).toEqual(before);
 });
 it('refuses a regular run under an actually closed additional-only statutory month',async()=>{const bonus=await batch('bonus');await closeBatch(ctx,{batchId:bonus});const before=await state();expect(before.periods.find(row=>row.period===period)?.status).toBe('closed');await expect(createBatch(ctx,{companyId:b.companyId,payPeriod:period})).rejects.toThrow('This pay period is closed.');expect(await state()).toEqual(before);});
 it('partial complete-set TRY ownership is released ONLY through whole command rollback and never creates a parent',async()=>{const selections=[{companyId:b.companyId,payPeriod:period},{companyId:b.companyId,payPeriod:otherPeriod}].sort((a,b)=>payrollPeriodOwnerKey(ctx.tenantId,a).localeCompare(payrollPeriodOwnerKey(ctx.tenantId,b))),later=payrollPeriodOwnerKey(ctx.tenantId,selections[1]),earlier=payrollPeriodOwnerKey(ctx.tenantId,selections[0]),before=await state();let ready!:()=>void,release!:()=>void;const start=new Promise<void>(yes=>{ready=yes;}),finish=new Promise<void>(yes=>{release=yes;}),holder=owner.db.transaction(async tx=>{await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${later},0))`);ready();await finish;});await start;try{await expect(withTenant(ctx,tx=>lockPayrollPeriodsTx(tx,ctx,selections,true))).rejects.toBeInstanceOf(PayrollPeriodOwnershipUnavailable);expect(await state()).toEqual(before);const [probe]=await owner.db.transaction(tx=>tx.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${earlier},0)) as owned`));expect(probe.owned).toBe(true);}finally{release();await holder;}});
 it('database UUID aliases contend with the actual nominated lowercase company/month key and never create an alternate resource',async()=>{const id=await batch(),[actual]=await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,id)),key=payrollPeriodOwnerKey(ctx.tenantId,{companyId:actual.companyId,payPeriod:actual.payPeriod});expect(payrollPeriodOwnerKey(ctx.tenantId.toUpperCase(),{companyId:actual.companyId.toUpperCase(),payPeriod:actual.payPeriod})).toBe(key);let ready!:()=>void,release!:()=>void;const start=new Promise<void>(yes=>{ready=yes;}),finish=new Promise<void>(yes=>{release=yes;}),holder=owner.db.transaction(async tx=>{await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key},0))`);ready();await finish;});await start;const before=await state();try{for(const companyId of [actual.companyId.toUpperCase(),'{'+actual.companyId+'}',actual.companyId.replaceAll('-','')])await expect(withTenant(ctx,tx=>lockPayrollPeriodsTx(tx,ctx,[{companyId,payPeriod:actual.payPeriod}],true))).rejects.toBeInstanceOf(PayrollPeriodOwnershipUnavailable);expect(await state()).toEqual(before);}finally{release();await holder;}await withTenant(ctx,tx=>lockPayrollPeriodsTx(tx,ctx,[{companyId:actual.companyId.toUpperCase(),payPeriod:actual.payPeriod}],true));});
 // Alpha's atomic revision owner (faf35b7a3, Oct 26) replaced the per-month record-based commit: one attempt commits every month or none,
 // re-planning under the tenant Access owner the native creator also holds. A month occupied meanwhile therefore refuses the WHOLE attempt;
 // the still-valid month commits only through a fresh attempt. Updated from the pre-alpha per-month partial-commit expectation.
 it('history refuses the WHOLE atomic import when a period becomes occupied under the SAME owner; a fresh import then commits the still-valid month',async()=>{await owner.db.update(s.company).set({companyLabel:'FIC_C'}).where(eq(s.company.id,b.companyId));await seedPayrollCycleCatalog(ctx,b.companyId);for(const code of ['BASIC','ALLOWANCE'])await createPayComponent(ctx,{code,name:'Fictional '+code,label:code,kind:'allowance',displayCategory:code==='BASIC'?'basic':'allowance',includedInEpf:false,includedInSocsoEis:false,includedInPcb:false,includedInHrdfBase:false,isNonPayable:false,prorates:false});const values=[['BASIC','5000.00'],['ALLOWANCE','300.00'],['EEEPF','583.00'],['EESOCSO','24.75'],['EEEIS','9.90'],['PCB','150.00'],['EREPF','689.00'],['ERSOCSO','86.65'],['EREIS','9.90']],recordsFor=(months:string[])=>parseCsvRecords([PAYROLL_HISTORY_HEADERS.join(','),...months.flatMap(month=>values.map(([code,amount])=>['FIC001',month.replace('-',''),'ME',code,'FIC_C',amount,'1'].join(',')))].join('\n')).records;const [parent]=await owner.db.insert(s.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period,status:'open'}).returning(),holder=await holdRow('period',parent.id),creator=createBatch(ctx,{companyId:b.companyId,payPeriod:period});void creator.catch(()=>undefined);let importer:ReturnType<typeof commitPayrollHistoryImport>|undefined;try{const firstPid=await waitingOn(holder.pid);importer=commitPayrollHistoryImport(ctx,{companyId:b.companyId,records:recordsFor([period,otherPeriod])});void importer.catch(()=>undefined);await waitingOn(firstPid);}finally{holder.release();await holder.done;}const created=await creator,result=await importer!,after=await state();expect(result.importedMonths).toBe(0);expect(result.imported).toBe(0);expect(result.issues.some(issue=>issue.status==='Failed'&&issue.employeeNo===''&&issue.period==='')).toBe(true);expect(after.batches.find(row=>row.id===created.batchId)?.status).toBe('draft');expect(after.batches.filter(row=>row.payPeriod===otherPeriod)).toEqual([]);expect(after.slips).toEqual([]);const retry=await commitPayrollHistoryImport(ctx,{companyId:b.companyId,records:recordsFor([otherPeriod])}),final=await state();expect(retry.importedMonths).toBe(1);expect(final.batches.find(row=>row.id===created.batchId)?.status).toBe('draft');expect(final.slips.filter(row=>row.batchId===created.batchId)).toEqual([]);const historical=final.batches.find(row=>row.payPeriod===otherPeriod)!;expect(historical.status).toBe('closed');expect(final.slips.filter(row=>row.batchId===historical.id)).toHaveLength(1);});
});
