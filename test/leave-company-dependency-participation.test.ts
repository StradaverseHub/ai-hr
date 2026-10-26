/** Actual tenant configuration/employee-interval interleavings, authored UNRUN. No module installer,
 * company mutation, deletion/retention gate, RLS query or event writer is mocked. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {createCompany,updateCompany,archiveCompany,deleteCompany,setCompanyLeaveCycle,setLeaveHalfDayFullDeduction,setLeaveHalfDayFullDeductionCompanies} from '../core/admin';
import {hireEmployee} from '../core/org';
import {lockLeaveDependenciesTx} from '../packs/leave/service';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
async function employee(){return hireEmployee(adminCtx(b),{person:{fullName:'Fictional Company Dependency Subject',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});}
async function state(){return{
 companies:await owner.db.select().from(s.company).where(eq(s.company.tenantId,b.tenantId)).orderBy(s.company.id),
 employees:await owner.db.select().from(s.employment).where(eq(s.employment.tenantId,b.tenantId)).orderBy(s.employment.id),
 assignments:await owner.db.select().from(s.assignment).where(eq(s.assignment.tenantId,b.tenantId)).orderBy(s.assignment.id),
 departments:await owner.db.select().from(s.department).where(eq(s.department.tenantId,b.tenantId)).orderBy(s.department.id),
 reporting:await owner.db.select().from(s.reportingLine).where(eq(s.reportingLine.tenantId,b.tenantId)).orderBy(s.reportingLine.id),
 types:await owner.db.select().from(s.leaveType).where(eq(s.leaveType.tenantId,b.tenantId)).orderBy(s.leaveType.id),
 templates:await owner.db.select().from(s.entitlementTemplate).where(eq(s.entitlementTemplate.tenantId,b.tenantId)).orderBy(s.entitlementTemplate.id),
 ledger:await owner.db.select().from(s.leaveLedger).where(eq(s.leaveLedger.tenantId,b.tenantId)).orderBy(s.leaveLedger.id),
 cycles:await owner.db.select().from(s.payrollCycle).where(eq(s.payrollCycle.tenantId,b.tenantId)).orderBy(s.payrollCycle.id),
 payroll:await owner.db.select().from(s.companyPayrollConfig).where(eq(s.companyPayrollConfig.tenantId,b.tenantId)).orderBy(s.companyPayrollConfig.id),
 toil:await owner.db.select().from(s.toilPolicy).where(eq(s.toilPolicy.tenantId,b.tenantId)).orderBy(s.toilPolicy.id),
 encashment:await owner.db.select().from(s.leaveEncashmentPolicy).where(eq(s.leaveEncashmentPolicy.tenantId,b.tenantId)).orderBy(s.leaveEncashmentPolicy.id),
 events:await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)).orderBy(s.domainEvent.id),
};}
async function held(employeeId:string,work:()=>Promise<void>){
 let ready!:()=>void,fail!:(error:unknown)=>void,release!:()=>void;
 const start=new Promise<void>((yes,no)=>{ready=yes;fail=no;}),finish=new Promise<void>(yes=>{release=yes;});
 const timer=setTimeout(()=>{fail(Error('owned company dependency handshake timed out'));release();},10000);
 const holder=withTenant(adminCtx(b),async tx=>{await lockLeaveDependenciesTx(tx,b.tenantId,[employeeId]);ready();await finish;});void holder.catch(fail);
 try{await start;await work();}finally{release();clearTimeout(timer);await holder;}
}
describe('canonical company dependency configuration owners',()=>{
 it.each(['create','update','archive','delete','cycle','half','half-set'] as const)('%s refuses before company/seed/catalogue/policy/graph/event effects while a real employee interval is held, then performs the original mutation',async command=>{
  const ctx=adminCtx(b),subject=await employee();let target=b.companyId;
  if(command==='delete'||command==='half-set')target=(await createCompany(ctx,{legalName:'Fictional unused dependency company',companyLabel:'FICT-UNUSED',country:'MY',currency:'MYR'})).id;
  if(command==='half-set')await setLeaveHalfDayFullDeduction(ctx,{companyId:target,enabled:true});
  const mutate=()=>{
   switch(command){
    case 'create':return createCompany(ctx,{legalName:'Fictional newly configured company',companyLabel:'FICT-NEW',country:'MY',currency:'MYR'});
    case 'update':return updateCompany(ctx,{id:b.companyId,legalName:'Fictional updated company',companyLabel:'FICT-UPDATED',country:'MY',currency:'MYR'});
    case 'archive':return archiveCompany(ctx,{id:b.companyId,archived:true});
    case 'delete':return deleteCompany(ctx,{id:target});
    case 'cycle':return setCompanyLeaveCycle(ctx,{companyId:b.companyId,cycle:'anniversary'});
    case 'half':return setLeaveHalfDayFullDeduction(ctx,{companyId:b.companyId,enabled:true});
    case 'half-set':return setLeaveHalfDayFullDeductionCompanies(ctx,{companyIds:[b.companyId]});
   }
  };
  const before=await state();await held(subject.employmentId,async()=>{await expect(mutate()).rejects.toThrow('Leave source is unavailable');expect(await state()).toEqual(before);});
  await mutate();const after=await state();expect(after).not.toEqual(before);
  switch(command){
   case 'create':{const created=after.companies.find(row=>row.companyLabel==='FICT-NEW');expect(created).toBeTruthy();expect(after.cycles.filter(row=>row.companyId===created!.id).length).toBeGreaterThan(0);break;}
   case 'update':expect(after.companies.find(row=>row.id===b.companyId)).toMatchObject({legalName:'Fictional updated company',companyLabel:'FICT-UPDATED'});break;
   case 'archive':expect(after.companies.find(row=>row.id===b.companyId)?.archivedAt).not.toBeNull();break;
   case 'delete':expect(after.companies.some(row=>row.id===target)).toBe(false);expect(after.cycles.some(row=>row.companyId===target)).toBe(false);break;
   case 'cycle':expect(after.companies.find(row=>row.id===b.companyId)?.leaveCycle).toBe('anniversary');break;
   case 'half':expect(after.companies.find(row=>row.id===b.companyId)?.leaveHalfDayFullDeduction).toBe(true);break;
   case 'half-set':expect(after.companies.find(row=>row.id===b.companyId)?.leaveHalfDayFullDeduction).toBe(true);expect(after.companies.find(row=>row.id===target)?.leaveHalfDayFullDeduction).toBe(false);break;
  }
 });
 it('retains the production full-set empty-selection meaning and emits no event on an unchanged repeat',async()=>{
  const ctx=adminCtx(b),subject=await employee();await setLeaveHalfDayFullDeductionCompanies(ctx,{companyIds:[b.companyId]});const before=await state();
  await held(subject.employmentId,async()=>{await expect(setLeaveHalfDayFullDeductionCompanies(ctx,{companyIds:[]})).rejects.toThrow('Leave source is unavailable');expect(await state()).toEqual(before);});
  expect(await setLeaveHalfDayFullDeductionCompanies(ctx,{companyIds:[]})).toMatchObject({disabled:[b.companyId]});const after=await state();
  expect(await setLeaveHalfDayFullDeductionCompanies(ctx,{companyIds:[]})).toMatchObject({enabled:[],disabled:[]});expect(await state()).toEqual(after);
 });
 it('captures the complete company selection and actor before the real Access wait; retained-input mutation cannot retarget updates or audit attribution',async()=>{
  const ctx=adminCtx(b),originalActor=ctx.userId!,originalTenant=ctx.tenantId,other=(await createCompany(ctx,{legalName:'Fictional captured selection company',country:'MY',currency:'MYR'})).id;
  await setLeaveHalfDayFullDeduction(ctx,{companyId:other,enabled:true});
  let ready!:(pid:number)=>void,fail!:(error:unknown)=>void,release!:()=>void;
  const start=new Promise<number>((yes,no)=>{ready=yes;fail=no;}),finish=new Promise<void>(yes=>{release=yes;});
  const timer=setTimeout(()=>{fail(Error('owned company Access handshake timed out'));release();},10000);
  const holder=withTenant(ctx,async tx=>{await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+originalTenant},0))`);const [row]=await tx.execute<{pid:number}>(sql`select pg_backend_pid() as pid`);ready(row.pid);await finish;});void holder.catch(fail);
  let command:Promise<unknown>|undefined;
  try{
   const pid=await start,p={companyIds:[b.companyId]};command=setLeaveHalfDayFullDeductionCompanies(ctx,p);void command.catch(()=>undefined);
   let waiting=false;for(let attempt=0;attempt<100;attempt++){
    const [row]=await owner.db.execute<{waiting:boolean}>(sql`select exists(select 1 from pg_stat_activity a where a.datname=current_database() and a.wait_event_type='Lock' and a.wait_event='advisory' and ${pid}=any(pg_blocking_pids(a.pid))) as waiting`);
    if(row.waiting){waiting=true;break;}await new Promise(yes=>setTimeout(yes,10));
   }
   expect(waiting).toBe(true);p.companyIds.splice(0,1,other);ctx.userId=randomUUID();ctx.roles=[];ctx.grants=[];release();await holder;await command;
   const rows=await owner.db.select().from(s.company).where(eq(s.company.tenantId,originalTenant));expect(rows.find(row=>row.id===b.companyId)?.leaveHalfDayFullDeduction).toBe(true);expect(rows.find(row=>row.id===other)?.leaveHalfDayFullDeduction).toBe(false);
   const changes=await owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,originalTenant));const halfDayEvents=changes.filter(row=>row.eventType==='company.leave-half-day-deduction.changed');expect(halfDayEvents).toHaveLength(3);expect(halfDayEvents.every(row=>row.actorId===originalActor)).toBe(true);
  }finally{release();clearTimeout(timer);await holder;if(command)await command.catch(()=>undefined);}
 });
});
