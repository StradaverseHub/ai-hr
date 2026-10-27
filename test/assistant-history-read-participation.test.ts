/** Authored UNRUN. Real app transactions and observed advisory-lock metadata, no mocked reader.
 * Needs the normal Board-history and AI-control migration install; never applies SQL or skips.
 * Watchdogs fail and release owned holders; elapsed time is never evidence of successful waiting. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {assignRole,createCompany} from '../core/admin';
import {grantAssistant} from '../core/assistant-grant';
import {withAssistantRead,withAssistantJobReadsTx} from '../core/assistant-read-session';
import {lockPayrollHistoryWriteTx} from '../core/payroll-history-lock';
import {myPayslips,myReleasedPayslipRuns} from '../core/read';
import {previewPayrollHistoryUpload,confirmPayrollHistoryUpload} from '../core/payroll-history-revisions';
import {seedPayrollCycleCatalog} from '../core/payroll-cycle';
import {PAYROLL_HISTORY_HEADERS} from '../lib/payroll-history-import-schema';
import {toCsv} from '../lib/csv';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base,a:SessionContext,ctx:SessionContext,employmentId:string,personId:string;
const year=Number(todayInKualaLumpur().slice(0,4))-2,period=`${year}-01`;
const modules=['payroll','multi_cycle_payroll'] as const;
const historyRows=()=>[['0007',period,'ME','BASIC','000AC','5000.00','1'],...['EEEPF','EESOCSO','EEEIS','PCB'].map(code=>['0007',period,'ME',code,'000AC','0.00','1'])];
const sourceContent=()=>Buffer.from(toCsv([Array.from(PAYROLL_HISTORY_HEADERS),...historyRows()]));
async function historyCatalogue(){
 await owner.db.update(s.company).set({companyLabel:'000AC'}).where(eq(s.company.id,b.companyId));await seedPayrollCycleCatalog(a,b.companyId);
 await owner.db.insert(s.payComponent).values({tenantId:b.tenantId,code:'BASIC',name:'Basic salary',kind:'allowance',displayCategory:'basic'});
}
beforeAll(async()=>{
 await migrateTestDb();
 const [installed]=await owner.db.execute<{controls:boolean;history:boolean}>(sql`select to_regprocedure('app.ai_action_unpaused(text,boolean)') is not null as controls,to_regclass('public.payroll_history_import_attempt') is not null as history`);
 expect(installed,'Install the actual reviewed AI controls and Board history schema through the normal migration owner').toEqual({controls:true,history:true});
});
afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();for(const module of ['assistant',...modules])await setModule(b.tenantId,module,'active');
 a={...await entitledCtx(b),personId:null,grants:[{role:'hr_admin',companyId:null}]};
 const hired=await hireEmployee(a,{person:{fullName:'Fictional history reader',primaryEmail:randomUUID()+'@fixture.test'},employeeCode:'0007',companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:`${year-1}-01-01`});
 employmentId=hired.employmentId;personId=hired.personId;
 const userId=await createAppUser(b.tenantId,personId,'hr_admin');await grantAssistant(a,{appUserId:userId});
 ctx={...await entitledCtx(b),userId,personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
});
async function state(){return{
 people:await owner.db.select().from(s.person).where(eq(s.person.tenantId,b.tenantId)).orderBy(s.person.id),
 batches:await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.tenantId,b.tenantId)).orderBy(s.payrollBatch.id),
 payslips:await owner.db.select().from(s.payslip).where(eq(s.payslip.tenantId,b.tenantId)).orderBy(s.payslip.id),
 events:await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(s.domainEvent.id)
};}
async function holdHistory(){
 let ready!:(pid:number)=>void,fail!:(error:unknown)=>void,release!:()=>void;
 const started=new Promise<number>((yes,no)=>{ready=yes;fail=no;}),finish=new Promise<void>(yes=>{release=yes;});
 const done=withTenant(a,async tx=>{
  await lockPayrollHistoryWriteTx(tx,b.tenantId);
  const [backend]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);ready(backend.pid);await finish;
 });
 void done.catch(fail);
 const timer=setTimeout(()=>{fail(Error('Owned history handshake timed out'));release();},8000);
 try{const pid=await started;clearTimeout(timer);return {pid,done,release};}catch(error){clearTimeout(timer);release();await done;throw error;}
}
async function pendingHistoryReader(holderPid:number,reader:Promise<unknown>){
 let settled=false;void reader.then(()=>{settled=true;},()=>{settled=true;});
 const deadline=Date.now()+4000;
 while(Date.now()<deadline){
  if(settled)throw Error('Ordinary reader settled before its actual history lock wait was observed');
  const [row]=await owner.db.execute<{waiting:boolean}>(sql`select exists(
   select 1 from pg_locks l join pg_stat_activity activity on activity.pid=l.pid
   where l.locktype='advisory' and not l.granted and l.mode='ShareLock' and l.objsubid=1
   and l.database=(select oid from pg_database where datname=current_database())
   and ((l.classid::bigint << 32) | l.objid::bigint)=hashtextextended(${'payroll-history:'+b.tenantId},0)
   and ${holderPid}::integer=any(pg_blocking_pids(l.pid)) and activity.datname=current_database()
  ) as waiting`);
  if(row?.waiting)return;
  await new Promise(resolve=>setTimeout(resolve,20));
 }
 throw Error('No actual ordinary history shared-lock request observed');
}
async function accessIsFree(){return withTenant(a,async tx=>{
 const [row]=await tx.execute<{owned:boolean}>(sql`select pg_try_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0)) as owned`);
 return row?.owned===true;
});}

describe('Assistant and ordinary readers participate in Board history ownership',()=>{
 it.each(modules)('%s supplied source refuses while history is held, rolls back its whole caller and succeeds after release',async module=>{
  const before=await state(),holder=await holdHistory();let reachedAfterRead=false,timedOut=false;
  // This real permitted write is only a rollback sentinel, never a canonical payroll/source mock.
  const pending=withTenant(ctx,async tx=>{
   const changed=await tx.update(s.person).set({fullName:'MUST_ROLL_BACK_HISTORY_SENTINEL'}).where(eq(s.person.id,personId)).returning({id:s.person.id});expect(changed).toHaveLength(1);
   const source=await withAssistantJobReadsTx(ctx,tx,read=>read.moduleWork(module));reachedAfterRead=true;return source;
  });
  void pending.catch(()=>undefined);
  let timer:ReturnType<typeof setTimeout>|undefined;
  const watchdog=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{timedOut=true;holder.release();reject(Error('Supplied history read waited instead of refusing'));},4000);});
  try{
   await expect(Promise.race([pending,watchdog])).rejects.toThrow('data access');
   if(timer)clearTimeout(timer);
   expect(timedOut).toBe(false);expect(reachedAfterRead).toBe(false);expect(await state()).toEqual(before);
   // While the original History writer remains held, the failed TOP-LEVEL caller has released Access.
   expect(await accessIsFree()).toBe(true);
  }finally{if(timer)clearTimeout(timer);holder.release();await holder.done;await pending.catch(()=>undefined);}
  const actual=await withAssistantRead(ctx,module,read=>read.moduleWork(module));expect(actual).toMatchObject({module,scope:'current-caller',data:{rows:[],truncated:false}});
  expect(await state()).toEqual(before);
 });

 it.each(['payslips','released-runs'] as const)('ordinary %s actually waits on Board shared history ownership, then completes after release',async kind=>{
  const before=await state(),holder=await holdHistory();
  const reading=kind==='payslips'?myPayslips(ctx,[employmentId],true):myReleasedPayslipRuns(ctx);
  void reading.catch(()=>undefined);
  try{await pendingHistoryReader(holder.pid,reading);expect(await state()).toEqual(before);}
  finally{holder.release();await holder.done;await reading.catch(()=>undefined);}
  expect(await reading).toEqual([]);expect(await state()).toEqual(before);
 });

 it('a real immutable imported history snapshot stays non-issued in ordinary and supplied own payslip/released-run reads',async()=>{
  await historyCatalogue();
  const preview=await previewPayrollHistoryUpload(a,{name:'fictional-reader-history.csv',content:sourceContent(),operationKey:randomUUID()});
  expect(preview.plan.issues).toEqual([]);
  expect(preview.plan.rows.map(row=>row.reasons)).toEqual([[]]);
  expect(preview.plan.counts).toEqual({created:1,replaced:0,unchanged:0,invalid:0});
  const committed=await confirmPayrollHistoryUpload(a,{attemptId:preview.attemptId,previewHash:preview.plan.previewHash,confirmReplacement:false,expectedCompanyId:b.companyId});
  expect(committed.changes).toHaveLength(1);expect(committed.changes[0].snapshotId).toBeTruthy();
  const before=await state(),ordinary=await myPayslips(ctx,[employmentId],true);
  expect(ordinary).toHaveLength(1);expect(ordinary[0]).toMatchObject({id:committed.changes[0].snapshotId,employmentId,historyImportAttemptId:preview.attemptId,historyImported:true,released:false});
  expect(await myReleasedPayslipRuns(ctx)).toEqual([]);
  const supplied=await withAssistantRead(ctx,'payroll',read=>read.myPayslips([employmentId],true));expect(supplied).toEqual(ordinary);
  for(const module of modules){const native=await withAssistantRead(ctx,module,read=>read.moduleWork(module));expect(native.data).toEqual({rows:[],truncated:false});}
  expect(await state()).toEqual(before);
 });
 it.each([false,true])('native history import never borrows foreign-company HR authority (target Payroll partner=%s)',async targetPartner=>{
  await historyCatalogue();
  const other=await createCompany(a,{legalName:'Fictional foreign HR scope',companyLabel:'FOREIGN',country:'MY',currency:'MYR'});
  const [login]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:'user_'+randomUUID(),personId:null}).returning({id:s.appUser.id});
  await assignRole(a,{appUserId:login.id,role:'hr_admin',companyId:other.id});
  if(targetPartner)await assignRole(a,{appUserId:login.id,role:'payroll_partner',companyId:b.companyId});
  const scoped:SessionContext={...await entitledCtx(b),userId:login.id,personId:null,roles:targetPartner?['hr_admin','payroll_partner']:['hr_admin'],grants:[{role:'hr_admin',companyId:other.id},...(targetPartner?[{role:'payroll_partner',companyId:b.companyId}]:[])]};
  const [nativeScope]=await withTenant(scoped,tx=>tx.execute<{current:boolean;foreignHr:boolean;targetHr:boolean;targetPayroll:boolean}>(sql`select app.principal_snapshot_current() as current,app.has_role_for('hr_admin',${other.id}::uuid) as "foreignHr",app.has_role_for('hr_admin',${b.companyId}::uuid) as "targetHr",app.can_admin_payroll_for(${b.companyId}::uuid) as "targetPayroll"`));
  expect(nativeScope).toEqual({current:true,foreignHr:true,targetHr:false,targetPayroll:targetPartner});
  const before=await state(),preview=await previewPayrollHistoryUpload(scoped,{name:'outside-hr-history.csv',content:sourceContent(),operationKey:randomUUID()});
  expect(preview.plan.counts.created).toBe(0);expect(preview.plan.counts.invalid).toBeGreaterThan(0);
  const reasons=preview.plan.rows.flatMap(row=>row.reasons).join(' ');
  expect(reasons).toMatch(targetPartner?/Payroll history import permission is unavailable/:/company code is unknown, ambiguous or outside your payroll scope/);
  await expect(confirmPayrollHistoryUpload(scoped,{attemptId:preview.attemptId,previewHash:preview.plan.previewHash,confirmReplacement:false,expectedCompanyId:b.companyId})).rejects.toThrow();
  const after=await state();expect(after.people).toEqual(before.people);expect(after.batches).toEqual(before.batches);expect(after.payslips).toEqual(before.payslips);
 });

});
