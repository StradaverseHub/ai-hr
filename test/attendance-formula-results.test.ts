import {afterAll,beforeAll,beforeEach,describe,it,expect} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {withTenant} from '../db/client';
import {hireEmployee} from '../core/org';
import {seedPayComponentCatalog} from '../core/pay-components';
import {checkIn,checkOut,setAttendancePolicy,saveAttendanceFormula,testAttendanceFormula,activateAttendanceFormula,changeAttendanceFormulaStatus,getAttendanceFormula,calculateAttendanceFormulaResult,reviewAttendanceFormulaResult,listAttendanceFormulaResults,attendanceFormulaSetup,listAttendanceFormulas,searchAttendanceFormulaEmployees,readAttendanceFormulaTest} from '../packs/attendance/service';
import {attendanceFormula,attendanceFormulaRevision,payComponent} from '../db/schema';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {AttendanceFormulaConfiguration} from '../lib/attendance-formula-model';
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();base=await seedBase();});
async function fixture(){const ctx=adminCtx(base),date=todayInKualaLumpur();const hired=await hireEmployee(ctx,{person:{fullName:'Fictional formula lifecycle employee',primaryEmail:'formula-lifecycle@example.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});await setAttendancePolicy(ctx,{companyId:base.companyId,workStart:'09:00',workEnd:'17:00',breakMinutes:0,lateAfter:'09:00',halfDayBefore:'13:00',workingDays:[1,2,3,4,5,6,7]});await checkIn(ctx,{employmentId:hired.employmentId,date,time:'09:00'});await checkOut(ctx,{employmentId:hired.employmentId,date,time:'19:00'});await seedPayComponentCatalog(ctx);const [item]=await owner.db.select().from(payComponent).where(eq(payComponent.code,'ATTENDANCE'));expect(item).toBeTruthy();const configuration:AttendanceFormulaConfiguration={code:'WORKED_HOURS',description:'Fictional reference earning only',companyId:base.companyId,payItemId:item.id,effectiveFrom:'2024-01-01',period:{method:'daily'},outputUnit:'amount',purpose:'earning',eligibility:{mode:'all'},posting:{kind:'exclusive'},library:{conditions:[],formulas:[{code:'WORKED_HOURS',source:'Return {#FormulaID}("TotalWorkingMins") / 60 * 10'}]}};return {ctx,date,employmentId:hired.employmentId,configuration};}
async function saved(){const f=await fixture();const version=await saveAttendanceFormula(f.ctx,{configuration:f.configuration});return {...f,...version};}

async function active(){const f=await saved(),proof=await testAttendanceFormula(f.ctx,{...f});await activateAttendanceFormula(f.ctx,{...f,testId:proof.id});return f;}
it('calculates a separate immutable native result and explicitly reviews/approves actual evidence',async()=>{
 const f=await active(),result=await calculateAttendanceFormulaResult(f.ctx,f);expect(result.amount).toBe('100.00');expect(result.quantity).toBe('100');
 expect((await calculateAttendanceFormulaResult(f.ctx,f)).id).toBe(result.id);
 await expect(reviewAttendanceFormulaResult(f.ctx,{resultId:result.id,command:'approve',reason:'Fictional approval'})).rejects.toThrow(/state/);
 await reviewAttendanceFormulaResult(f.ctx,{resultId:result.id,command:'review',reason:'Checked actual clock evidence'});
 await reviewAttendanceFormulaResult(f.ctx,{resultId:result.id,command:'approve',reason:'Authorized fictional earning'});
 const rows=await listAttendanceFormulaResults(f.ctx,{employmentId:f.employmentId,date:f.date});expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({state:'approved',code:'WORKED_HOURS',payCode:'ATTENDANCE'});
 const {attendanceFormulaResult}=await import('../db/schema');await expect(owner.db.update(attendanceFormulaResult).set({amount:'999.00'}).where(eq(attendanceFormulaResult.id,result.id))).rejects.toThrow(/append-only/);
});
it('refuses stale review and preserves previous calculation history when actual clocks change',async()=>{
 const f=await active(),first=await calculateAttendanceFormulaResult(f.ctx,f);
 await checkIn(f.ctx,{employmentId:f.employmentId,date:f.date,time:'20:00'});await checkOut(f.ctx,{employmentId:f.employmentId,date:f.date,time:'21:00'});
 await expect(reviewAttendanceFormulaResult(f.ctx,{resultId:first.id,command:'review',reason:'Stale actual inputs'})).rejects.toThrow(/changed/);
 const second=await calculateAttendanceFormulaResult(f.ctx,f);expect(second.id).not.toBe(first.id);const rows=await listAttendanceFormulaResults(f.ctx,{employmentId:f.employmentId,date:f.date});expect(rows).toHaveLength(2);expect(rows.find(row=>row.result.id===first.id)?.state).toBe('superseded');
});
it('refuses inactive and not-yet-effective processing, and a real other tenant cannot read result evidence',async()=>{
 const f=await saved();await expect(calculateAttendanceFormulaResult(f.ctx,f)).rejects.toThrow(/Activate/);
 const proof=await testAttendanceFormula(f.ctx,f);await activateAttendanceFormula(f.ctx,{...f,testId:proof.id});const result=await calculateAttendanceFormulaResult(f.ctx,f);
 const foreign=adminCtx(await seedBase());expect(await listAttendanceFormulaResults(foreign,{employmentId:f.employmentId,date:f.date})).toEqual([]);
 await expect(reviewAttendanceFormulaResult(foreign,{resultId:result.id,command:'review',reason:'Foreign review'})).rejects.toThrow();
 const future=await saveAttendanceFormula(f.ctx,{configuration:{...f.configuration,code:'FUTURE_RULE',effectiveFrom:'2099-01-01',library:{conditions:[],formulas:[{code:'FUTURE_RULE',source:'Return 1'}]}}});const validation=await testAttendanceFormula(f.ctx,{...f,...future});await activateAttendanceFormula(f.ctx,{...future,testId:validation.id});await expect(calculateAttendanceFormulaResult(f.ctx,{...f,id:future.id})).rejects.toThrow(/effective/);
});
