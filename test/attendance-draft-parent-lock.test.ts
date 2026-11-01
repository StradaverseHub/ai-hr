/** Actual native exclusion: independent Attendance shares a draft, incoming payslips own its parent. */
import {randomUUID} from 'node:crypto';
import {and,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import {withDataCommand} from '../core/data-command';
import {lockPayrollForAttendanceChange} from '../core/payroll-closed-runs';
import {hireEmployee} from '../core/org';
import * as s from '../db/schema';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
function barrier(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return{promise,resolve};}
const settled=<T,>(work:PromiseLike<T>)=>Promise.resolve(work).then(value=>({ok:true as const,value}),error=>({ok:false as const,error}));
async function fixture(){
 await resetDb();const b=await seedBase(),ctx=adminCtx(b),date=todayInKualaLumpur(),month=date.slice(0,7);
 const people=[];for(let i=0;i<3;i++)people.push(await hireEmployee(ctx,{person:{fullName:'Fictional native lock subject '+i,primaryEmail:randomUUID()+'@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'}));
 const draft=async(period:string)=>{const [p]=await owner.db.insert(s.payPeriod).values({tenantId:b.tenantId,companyId:b.companyId,period}).returning();const [row]=await owner.db.insert(s.payrollBatch).values({tenantId:b.tenantId,companyId:b.companyId,payPeriodId:p.id,payPeriod:period,batchDate:period+'-15'}).returning();return row;};
 const batch=await draft(month);
 const slip=(batchId:string,employmentId=people[2].employmentId)=>({tenantId:b.tenantId,batchId,employmentId,basicSalary:'0',grossPay:'0',statutory:{},totalDeductions:'0',netPay:'0',employerCost:'0'});
 return{b,ctx,date,month,people,batch,draft,slip};
}
async function nativeWait(fragment:string,min=1){const until=Date.now()+3000;while(Date.now()<until){const [row]=await owner.client`select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and position(${fragment} in query)>0 and cardinality(pg_blocking_pids(pid))>0`;if(row.n>=min)return;await delay(10);}throw new Error('Expected physical native wait: '+fragment);}
it('retains private financial owners and binds incoming membership writes to the native parent owner',async()=>{
 const [row]=await owner.client`select p.prosecdef,p.provolatile,p.proconfig,
 p.proowner=(select proowner from pg_proc where oid='app.attendance_payroll_protection_rows(uuid)'::regprocedure) as same_owner,
 has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app_execute,
 exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute
 from pg_proc p where oid='app.lock_payslip_attendance_membership()'::regprocedure`;
 expect(row).toEqual({prosecdef:true,provolatile:'v',proconfig:['search_path=pg_catalog, public, pg_temp'],same_owner:true,app_execute:false,public_execute:false});
 const [trigger]=await owner.client`select tgtype,tgenabled from pg_trigger where tgrelid='public.payslip'::regclass and tgname='payslip_attendance_membership_lock' and tgfoid='app.lock_payslip_attendance_membership()'::regprocedure`;
 expect(trigger).toEqual({tgtype:23,tgenabled:'O'});
 const guards=await owner.client`select p.provolatile,p.prosecdef,has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app_execute from pg_proc p where p.oid in ('app.attendance_payroll_protection_rows(uuid)'::regprocedure,'app.attendance_payroll_protection_rows(uuid,date[])'::regprocedure)`;
 expect(guards).toHaveLength(2);expect(guards.every(row=>row.provolatile==='v'&&row.prosecdef&&!row.app_execute)).toBe(true);
});
it('commits distinct real Attendance inserts while first app-role payslip and status writers physically wait',async()=>{
 const f=await fixture(),entered=barrier(),release=barrier();
 const first=settled(withDataCommand(f.ctx,async tx=>{expect(await lockPayrollForAttendanceChange(tx,f.people[0].employmentId,f.date)).toEqual([]);entered.resolve();await release.promise;await tx.insert(s.attendance).values({tenantId:f.b.tenantId,employmentId:f.people[0].employmentId,attendanceDate:f.date,status:'present'});}));
 let other:ReturnType<typeof settled>|undefined,slip:ReturnType<typeof settled>|undefined,status:ReturnType<typeof settled>|undefined;
 try{
  expect(await Promise.race([entered.promise.then(()=>true),first.then(()=>false),delay(3000).then(()=>false)])).toBe(true);
  other=settled(withDataCommand(f.ctx,async tx=>{expect(await lockPayrollForAttendanceChange(tx,f.people[1].employmentId,f.date)).toEqual([]);await tx.insert(s.attendance).values({tenantId:f.b.tenantId,employmentId:f.people[1].employmentId,attendanceDate:f.date,status:'present'});}));
  expect(await Promise.race([other.then(row=>row.ok),delay(250).then(()=>false)]),'distinct source commits before first source releases draft coverage').toBe(true);
  slip=settled(withTenant(f.ctx,tx=>tx.insert(s.payslip).values(f.slip(f.batch.id))));await nativeWait('insert into "payslip"');
  status=settled(owner.db.update(s.payrollBatch).set({status:'processed'}).where(eq(s.payrollBatch.id,f.batch.id)));await nativeWait('update "payroll_batch"');
 }finally{release.resolve();const outcomes=await Promise.all([first,...(other?[other]:[]),...(slip?[slip]:[]),...(status?[status]:[])]);expect(outcomes.every(row=>row.ok)).toBe(true);}
 expect(await owner.db.select().from(s.attendance).where(eq(s.attendance.tenantId,f.b.tenantId))).toHaveLength(2);
 expect(await owner.db.select().from(s.payslip).where(eq(s.payslip.batchId,f.batch.id))).toHaveLength(1);
});
it('does not create a row/advisory cycle when a raw app first-payslip writer changes status in the same transaction',async()=>{
 const f=await fixture(),inserted=barrier(),proceed=barrier();
 const write=settled(withTenant(f.ctx,async tx=>{await tx.insert(s.payslip).values(f.slip(f.batch.id));inserted.resolve();await proceed.promise;await tx.update(s.payrollBatch).set({status:'processed'}).where(eq(s.payrollBatch.id,f.batch.id));}));
 expect(await Promise.race([inserted.promise.then(()=>true),write.then(()=>false),delay(3000).then(()=>false)])).toBe(true);
 const guard=settled(withDataCommand(f.ctx,tx=>lockPayrollForAttendanceChange(tx,f.people[2].employmentId,f.date)));
 try{await nativeWait('app.attendance_payroll_protection(');}finally{proceed.resolve();}
 const result=await Promise.all([write,guard]);expect(result.every(row=>row.ok)).toBe(true);expect(result[1]).toMatchObject({ok:true,value:[{batchId:f.batch.id,status:'processed'}]});
});
it('reacquires original exclusive ownership after two guards observe an in-flight draft-to-processed change',async()=>{
 const f=await fixture();await owner.db.insert(s.payslip).values(f.slip(f.batch.id,f.people[0].employmentId));
 const changed=barrier(),commit=barrier();const writer=owner.client.begin(async connection=>{await connection`update payroll_batch set status='processed' where id=${f.batch.id}::uuid`;changed.resolve();await commit.promise;});await changed.promise;
 const reads=f.people.slice(0,2).map(person=>settled(withDataCommand(f.ctx,tx=>lockPayrollForAttendanceChange(tx,person.employmentId,f.date))));
 try{await nativeWait('app.attendance_payroll_protection(',2);}finally{commit.resolve();await writer;}
 expect(await Promise.all(reads)).toEqual([{ok:true,value:[{batchId:f.batch.id,status:'processed'}]},{ok:true,value:[]}]);
});
it.each(['processed','closed'] as const)('retains exclusive %s coverage and the exact existing financial facts',async state=>{
 const f=await fixture();await owner.db.insert(s.payslip).values(f.slip(f.batch.id,f.people[0].employmentId));await owner.db.update(s.payrollBatch).set({status:state}).where(eq(s.payrollBatch.id,f.batch.id));
 await withDataCommand(f.ctx,async tx=>{expect(await lockPayrollForAttendanceChange(tx,f.people[0].employmentId,f.date)).toEqual([{batchId:f.batch.id,status:state}]);let denied=false;try{await owner.client.begin(connection=>connection`select id from payroll_batch where id=${f.batch.id}::uuid for share nowait`);}catch(error){expect((error as {code:string}).code).toBe('55P03');denied=true;}expect(denied).toBe(true);});
});
it('protects incoming membership moves without adding an outgoing-parent lock inversion',async()=>{
 const f=await fixture(),oldMonth=new Date(Date.parse(f.month+'-01T12:00:00Z')-180*86400000).toISOString().slice(0,7),donor=await f.draft(oldMonth);
 const [slip]=await owner.db.insert(s.payslip).values(f.slip(donor.id)).returning({id:s.payslip.id});
 const entered=barrier(),release=barrier();const first=settled(withDataCommand(f.ctx,async tx=>{await lockPayrollForAttendanceChange(tx,f.people[0].employmentId,f.date);entered.resolve();await release.promise;}));
 expect(await Promise.race([entered.promise.then(()=>true),first.then(()=>false),delay(3000).then(()=>false)])).toBe(true);
 const move=settled(withTenant(f.ctx,tx=>tx.update(s.payslip).set({batchId:f.batch.id}).where(eq(s.payslip.id,slip.id))));
 try{await nativeWait('update "payslip"');await owner.client.begin(connection=>connection`select id from payroll_batch where id=${donor.id}::uuid for share nowait`);}finally{release.resolve();}
 expect((await Promise.all([first,move])).every(row=>row.ok)).toBe(true);
 expect(await owner.db.select().from(s.payslip).where(and(eq(s.payslip.id,slip.id),eq(s.payslip.batchId,f.batch.id)))).toHaveLength(1);
});
it('keeps foreign-tenant financial writes and native Attendance correction authority refused',async()=>{
 const f=await fixture(),foreign=await seedBase();
 await expect(withTenant(adminCtx(foreign),tx=>tx.insert(s.payslip).values(f.slip(f.batch.id)))).rejects.toMatchObject({cause:{code:'42501'}});
 await expect(withTenant(adminCtx(foreign),tx=>tx.execute(sql`select * from app.attendance_payroll_protection(${f.people[0].employmentId}::uuid,ARRAY[${f.date}::date])`))).rejects.toMatchObject({cause:{message:expect.stringMatching(/Attendance correction authority required/)}});
 expect(await owner.db.select().from(s.payslip).where(eq(s.payslip.batchId,f.batch.id))).toHaveLength(0);
});
