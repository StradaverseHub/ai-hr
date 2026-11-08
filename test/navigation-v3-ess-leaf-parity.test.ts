/** Real canonical app-role leaf reads only; no ESS purpose, lease or page adoption. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as s from '../db/schema';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee,setEmploymentAssignment} from '../core/org';
import {assignmentHistory,assignmentHistoryTx} from '../core/read';
import {createProfileOption,listAllProfileOptions,listAllProfileOptionsTx,PROFILE_OPTION_CATEGORIES} from '../core/profile-options';
import {setCompensation,compensationHistoryDetailed} from '../core/comp';
import {seedPayComponentCatalog,listPayComponents,setEmploymentPayComponent,updateEmploymentPayComponent} from '../core/pay-components';
import {setCp38,terminateCp38} from '../core/cp38';
import {listEmploymentPayComponents,listEmploymentPayComponentsTx,listCp38,listCp38Tx,compensationHistoryDetailedTx} from '../packs/payroll/service';
import {withPayrollHistoryTenant} from '../packs/payroll/history';
import {shiftArrangementHistory,shiftArrangementHistoryTx,ownProfileAttendanceSummaryTx,ensureStandardRule} from '../packs/attendance/service';
import {assignEmployeeShiftDated} from '../core/shift-arrangement';
import {createShift,assignDefaultShift} from '../core/roster';
let b:Base,a:SessionContext,e:Awaited<ReturnType<typeof hireEmployee>>;
beforeAll(migrateTestDb);beforeEach(async()=>{
 await resetDb();b=await seedBase();a=adminCtx(b);
 e=await hireEmployee(a,{companyId:b.companyId,departmentId:b.deptA,positionId:b.positionId,employmentType:'full_time',hiredOn:'2020-01-01',person:{fullName:'Fictional ESS leaf',primaryEmail:randomUUID()+'@example.invalid'}});
});afterAll(closeAll);
async function identity(tx:Tx){
 const [row]=await tx.execute<{pid:number;backend:string;xid:string|null;tenant:string;userId:string;superuser:boolean;bypass:boolean}>(sql`
  select pg_backend_pid() as pid,(select backend_start::text from pg_stat_activity where pid=pg_backend_pid()) as backend,
   txid_current_if_assigned()::text as xid,current_setting('app.tenant_id') as tenant,current_setting('app.user_id') as "userId",
   (select rolsuper from pg_roles where rolname=current_user) as superuser,
   (select rolbypassrls from pg_roles where rolname=current_user) as bypass`);
 expect(row).toMatchObject({tenant:b.tenantId,superuser:false,bypass:false});expect(row.pid).toBeGreaterThan(1);expect(row.backend).toBeTruthy();return row;
}
async function parity<T>(legacy:()=>Promise<T>,leaf:(tx:Tx)=>PromiseLike<T>,history=false){
 const expected=await legacy();const carrier=history?withPayrollHistoryTenant:withTenant;
 const actual=await carrier(a,async tx=>{const before=await identity(tx);const rows=await leaf(tx);expect(await identity(tx)).toEqual(before);return rows;});
 expect(actual).toEqual(expected);return actual;
}
async function namedActor(name:string){
 const hired=await hireEmployee(a,{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01',person:{fullName:name,primaryEmail:randomUUID()+'@example.invalid'}});
 const userId=await createAppUser(b.tenantId,hired.personId,'hr_admin');
 a={...a,userId,personId:hired.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
}
async function makeShifts(){
 const input={companyId:b.companyId,startTime:'09:00:00',endTime:'18:00:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5]};
 const old=await createShift(a,{...input,code:'ESS-OLD',name:'Fictional Old'}),next=await createShift(a,{...input,code:'ESS-NEW',name:'Fictional New'});
 return {old,next};
}
async function inventory(){
 const rows=await Promise.all([
  owner.db.select().from(s.assignment).where(eq(s.assignment.tenantId,b.tenantId)),
  owner.db.select().from(s.compensation).where(eq(s.compensation.tenantId,b.tenantId)),
  owner.db.select().from(s.employmentPayComponent).where(eq(s.employmentPayComponent.tenantId,b.tenantId)),
  owner.db.select().from(s.employeeCp38).where(eq(s.employeeCp38.tenantId,b.tenantId)),
  owner.db.select().from(s.employmentShiftArrangement).where(eq(s.employmentShiftArrangement.tenantId,b.tenantId)),
  owner.db.select().from(s.profileOption).where(eq(s.profileOption.tenantId,b.tenantId)),
  owner.db.select().from(s.domainEvent).where(eq(s.domainEvent.tenantId,b.tenantId)),
 ]);return rows.map(values=>values.slice().sort((left,right)=>left.id.localeCompare(right.id)));
}
it('preserves complete dated assignment joins and newest-first order in the actual app transaction',async()=>{
 await setEmploymentAssignment(a,{employmentId:e.employmentId,effectiveDate:'2020-06-01',departmentId:b.deptB,positionId:b.positionId,employmentType:'contract'});
 const before=await inventory(),rows=await parity(()=>assignmentHistory(a,e.employmentId),tx=>assignmentHistoryTx(tx,e.employmentId));
 expect(rows.map(row=>row.validFrom)).toEqual(['2020-06-01','2020-01-01']);expect(rows[0]).toMatchObject({departmentId:b.deptB,positionId:b.positionId,employmentType:'contract'});
 expect(rows[1]).toMatchObject({departmentId:b.deptA,validTo:'2020-06-01'});expect(await inventory()).toEqual(before);
});
it('preserves active filtering, exact catalogue rows, ordering and every empty category bucket',async()=>{
 await createProfileOption(a,{category:'race',value:'ESS-B',label:'Fictional B',sortOrder:2,isActive:false});
 await createProfileOption(a,{category:'race',value:'ESS-A',label:'Fictional A',description:'fictional description',sortOrder:1});
 const before=await inventory(),all=await parity(()=>listAllProfileOptions(a),tx=>listAllProfileOptionsTx(tx));
 expect(Object.keys(all)).toEqual([...PROFILE_OPTION_CATEGORIES]);expect(all.race.filter(row=>row.value.startsWith('ESS-')).map(row=>row.value)).toEqual(['ESS-A','ESS-B']);
 const active=await parity(()=>listAllProfileOptions(a,{activeOnly:true}),tx=>listAllProfileOptionsTx(tx,{activeOnly:true}));
 expect(active.race.filter(row=>row.value.startsWith('ESS-'))).toEqual([expect.objectContaining({value:'ESS-A',description:'fictional description',isActive:true})]);expect(await inventory()).toEqual(before);
});
it('preserves detailed salary money strings, event actor joins and retained shared History carrier',async()=>{
 await namedActor('Fictional Salary Author');
 await setCompensation(a,{employmentId:e.employmentId,basicSalary:5100.25,monthlyAllowance:80.75,effectiveFrom:'2020-01-01',remarks:'fictional initial'});
 await setCompensation(a,{employmentId:e.employmentId,basicSalary:5300.50,effectiveFrom:'2020-06-01',remarks:'fictional revision'});
 const before=await inventory(),rows=await parity(()=>compensationHistoryDetailed(a,e.employmentId),tx=>compensationHistoryDetailedTx(tx,e.employmentId),true);
 expect(rows.map(row=>row.validFrom)).toEqual(['2020-06-01','2020-01-01']);expect(rows[0]).toMatchObject({basicSalary:'5300.50',monthlyAllowance:'80.75',remarks:'fictional revision',createdByName:'Fictional Salary Author'});
 expect(rows[1]).toMatchObject({basicSalary:'5100.25',monthlyAllowance:'80.75',remarks:'fictional initial'});expect(await inventory()).toEqual(before);
});
it('keeps ended recurring items visible, superseded revisions hidden and complete joined DTOs unchanged',async()=>{
 await seedPayComponentCatalog(a);const component=(await listPayComponents(a)).find(row=>row.code==='BASIC')!;expect(component.id).toBeTruthy();
 await setEmploymentPayComponent(a,{employmentId:e.employmentId,componentId:component.id,amount:125.25,effectiveFrom:'2020-01-01',effectiveTo:'2020-06-30',remarks:'fictional ended'});
 const current=await setEmploymentPayComponent(a,{employmentId:e.employmentId,componentId:component.id,amount:225.25,effectiveFrom:'2020-07-01'});
 await updateEmploymentPayComponent(a,{id:current.id,employmentId:e.employmentId,amount:225.75,effectiveFrom:'2020-07-01',remarks:'fictional revised'});
 const before=await inventory(),rows=await parity(()=>listEmploymentPayComponents(a,e.employmentId),tx=>listEmploymentPayComponentsTx(tx,e.employmentId));
 expect(rows).toHaveLength(2);expect(rows.map(row=>row.amount)).toEqual(['125.25','225.75']);expect(rows[0]).toMatchObject({validTo:'2020-06-30',code:'BASIC',remarks:'fictional ended'});expect(rows.some(row=>row.id===current.id)).toBe(false);expect(await inventory()).toEqual(before);
});
it('retains closed and superseded CP38 rows, decimal strings and descending date order',async()=>{
 const old=await setCp38(a,{employmentId:e.employmentId,cp38Ref:'FICT-OLD',amount:80.25,validFrom:'2020-03-17',validTo:'2020-05-20'});
 await setCp38(a,{employmentId:e.employmentId,cp38Ref:'FICT-NEW',amount:90.75,validFrom:'2020-06-01'});await terminateCp38(a,{id:old.id});
 const before=await inventory(),rows=await parity(()=>listCp38(a,{employmentId:e.employmentId}),tx=>listCp38Tx(tx,{employmentId:e.employmentId}),true);
 expect(rows.map(row=>row.cp38Ref)).toEqual(['FICT-NEW','FICT-OLD']);expect(rows[0].amount).toBe('90.75');expect(rows[1]).toMatchObject({id:old.id,amount:'80.25',validFrom:'2020-03-01',validTo:'2020-05-01'});expect(rows[1].supersededAt).toBeInstanceOf(Date);expect(await inventory()).toEqual(before);
});
it('preserves ascending previous-shift derivation before reversing the actual dated history DTO',async()=>{
 await namedActor('Fictional Shift Author');
 const {old,next}=await makeShifts();await assignEmployeeShiftDated(a,{employmentId:e.employmentId,shiftType:'fixed',shiftId:old.id,effectiveFrom:'2020-01-01'});
 await assignEmployeeShiftDated(a,{employmentId:e.employmentId,shiftType:'fixed',shiftId:next.id,effectiveFrom:'2020-07-01'});
 const before=await inventory(),rows=await parity(()=>shiftArrangementHistory(a,e.employmentId),tx=>shiftArrangementHistoryTx(tx,e.employmentId));
 expect(rows.map(row=>row.effectiveFrom)).toEqual(['2020-07-01','2020-01-01']);expect(rows[0]).toMatchObject({shiftCode:'ESS-NEW',previousShiftCode:'ESS-OLD',previousShiftName:'Fictional Old',changedByName:'Fictional Shift Author',recordedOnRelease:false});
 expect(rows[1]).toMatchObject({shiftCode:'ESS-OLD',previousShiftCode:null,effectiveTo:'2020-06-30'});expect(rows.every(row=>typeof row.changedAt==='string'&&row.changedAt.endsWith('Z'))).toBe(true);expect(await inventory()).toEqual(before);
});
it('keeps inclusive attendance end dates and permits the legacy default only with no history',async()=>{
 await ensureStandardRule(a);const {old,next}=await makeShifts();await assignDefaultShift(a,{employmentId:e.employmentId,shiftId:old.id});
 expect(await shiftArrangementHistory(a,e.employmentId)).toEqual([]);
 const read=(today:string,defaultShiftId:string,shifts:Awaited<ReturnType<typeof shiftArrangementHistory>>)=>withTenant(a,tx=>ownProfileAttendanceSummaryTx(tx,{employmentId:e.employmentId,today,defaultShiftId,shifts}));
 const legacy=await read('2020-06-30',old.id,[]);expect(legacy).toEqual({scheduleGroupName:'Standard',backupShiftCode:'ESS-OLD',backupShiftName:'Fictional Old',shiftEffectiveFrom:null});
 await assignEmployeeShiftDated(a,{employmentId:e.employmentId,shiftType:'fixed',shiftId:old.id,effectiveFrom:'2020-01-01'});
 await assignEmployeeShiftDated(a,{employmentId:e.employmentId,shiftType:'fixed',shiftId:next.id,effectiveFrom:'2020-07-01'});const shifts=await shiftArrangementHistory(a,e.employmentId);expect(shifts).toHaveLength(2);
 const before=await inventory(),end=await read('2020-06-30',next.id,shifts);expect(end).toMatchObject({backupShiftCode:'ESS-OLD',shiftEffectiveFrom:'2020-01-01'});
 const gap=await read('2019-12-31',next.id,shifts);expect(gap).toMatchObject({backupShiftCode:null,backupShiftName:null,shiftEffectiveFrom:null});expect(await inventory()).toEqual(before);
});
it('retains actual own-person and foreign-tenant RLS rather than treating a passed Tx as permission',async()=>{
 await setCompensation(a,{employmentId:e.employmentId,basicSalary:5100.25,effectiveFrom:'2020-01-01'});await setCp38(a,{employmentId:e.employmentId,cp38Ref:'FICT-OWN',amount:20.25,validFrom:'2020-03-01'});
 const userId=await createAppUser(b.tenantId,e.personId,'employee'),self:SessionContext={...a,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 const own=await withPayrollHistoryTenant(self,async tx=>({assignments:await assignmentHistoryTx(tx,e.employmentId),salary:await compensationHistoryDetailedTx(tx,e.employmentId),cp38:await listCp38Tx(tx,{employmentId:e.employmentId})}));
 expect(own.assignments).toHaveLength(1);expect(own.salary).toHaveLength(1);expect(own.cp38).toEqual([expect.objectContaining({amount:'20.25',cp38Ref:'FICT-OWN'})]);
 const foreign=await seedBase(),other=adminCtx(foreign);
 const denied=await withPayrollHistoryTenant(other,async tx=>({assignments:await assignmentHistoryTx(tx,e.employmentId),salary:await compensationHistoryDetailedTx(tx,e.employmentId),cp38:await listCp38Tx(tx,{employmentId:e.employmentId}),pay:await listEmploymentPayComponentsTx(tx,e.employmentId),shifts:await shiftArrangementHistoryTx(tx,e.employmentId)}));
 expect(denied).toEqual({assignments:[],salary:[],cp38:[],pay:[],shifts:[]});
});
