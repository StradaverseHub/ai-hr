/** Native dated policy fixture -> real Attendance result -> the existing single cash/TOIL parent. */
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {adminCtx,entitledCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import type {SessionContext} from '../db/client';import {withTenant} from '../db/client';
import {todayInKualaLumpur} from '../lib/hr-date';import {addDaysIso} from '../lib/roster-month';
import {createAttendancePolicyStorageFixtures} from './attendance-policy-storage-fixture';
import {setAttendancePolicy,saveAttendanceFormula,testAttendanceFormula,activateAttendanceFormula,calculateAttendanceFormulaResult,reviewAttendanceFormulaResult,readAttendanceFormulaDaysTx,reserveOvertimeSettlementTx} from '../packs/attendance/service';
import {createBatch,transferAttendanceFormulaResults,readPayrollOvertimePatternCashTx} from '../packs/payroll/service';
import {overtimeSourceSettlement} from '../db/schema';
let b:Base,ctx:SessionContext;const day=(n:number)=>addDaysIso(todayInKualaLumpur(),n);
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'attendance','active');await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'typed_pay_components','active');ctx=await entitledCtx(b);});
const {fixture}=createAttendancePolicyStorageFixtures({get b(){return b;},get ctx(){return ctx;},day});
async function source(){
 await setAttendancePolicy(ctx,{companyId:b.companyId,workStart:'09:00',workEnd:'18:00',breakMinutes:0,lateAfter:'09:00',halfDayBefore:'13:00',workingDays:[1,2,3,4,5,6,7]});
 // The shared fixture restores an explicitly historical policy baseline and verifies its guards
 // are re-enabled. All clocks, actual-source evaluation and financial commands remain native.
 const f=await fixture('auto','20','actual',true,undefined,0,true,{mode:'none',step:null},120,'earliest',false,day(-1),false,true);
 const date=f.sourceDate,configuration={code:'CUSTOM_OT',description:'Fictional approved after-shift premium',companyId:b.companyId,payItemId:f.earningId,effectiveFrom:day(-10),period:{method:'daily' as const},outputUnit:'amount' as const,purpose:'overtime' as const,eligibility:{mode:'all' as const},posting:{kind:'exclusive' as const},library:{conditions:[],formulas:[{code:'CUSTOM_OT',source:'Return {#FormulaID}("ApproveZoneBOT") / 60 * 25'}]}};
 const saved=await saveAttendanceFormula(ctx,{configuration}),proof=await testAttendanceFormula(ctx,{...saved,employmentId:f.employmentId,date});await activateAttendanceFormula(ctx,{...saved,testId:proof.id});const result=await calculateAttendanceFormulaResult(ctx,{id:saved.id,employmentId:f.employmentId,date});expect(result.amount).toBe('50.00');
 await reviewAttendanceFormulaResult(ctx,{resultId:result.id,command:'review',reason:'Checked actual approved physical coverage'});await reviewAttendanceFormulaResult(ctx,{resultId:result.id,command:'approve',reason:'Authorized fictional premium'});
 return {...f,date,result};
}
it('replays custom overtime once beneath real source settlements, excludes a rival legacy cash writer and retains exact money',async()=>{
 const f=await source(),coverage=await withTenant(ctx,tx=>readAttendanceFormulaDaysTx(tx,ctx,{companyId:b.companyId,employmentId:f.employmentId,from:f.date,to:f.date,variables:['ApproveZoneBOT']}));expect(coverage.overtimeCoverage[0]?.parts.reduce((sum,p)=>sum+p.minutes,0)).toBe(120);
 const {batchId}=await createBatch(ctx,{companyId:b.companyId,payPeriod:f.date.slice(0,7)}),request={batchId,resultIds:[f.result.id],reason:'Transfer reviewed fictional OT'};
 await transferAttendanceFormulaResults(ctx,request);expect((await transferAttendanceFormulaResults(ctx,request)).idempotent).toBe(true);
 const claims=await owner.db.select().from(overtimeSourceSettlement).where(eq(overtimeSourceSettlement.payrollBatchId,batchId));expect(claims).toHaveLength(1);expect(claims[0].formulaBindingId).toBeTruthy();expect(claims[0].coverageKind).toBe('formulaPhysical');
 const cash=await withTenant(ctx,tx=>readPayrollOvertimePatternCashTx(tx,ctx,{batchId}));expect(cash.lines.reduce((sum,line)=>sum+BigInt(line.amountMinorUnits),BigInt(0))).toBe(BigInt(5000));expect(cash.lines.reduce((sum,line)=>sum+Number(line.payableMinutes.numerator)/Number(line.payableMinutes.denominator),0)).toBe(120);expect(cash.lines.every(line=>line.evidence.mapping.earningItemId===f.earningId)).toBe(true);
 await expect(withTenant(ctx,tx=>reserveOvertimeSettlementTx(tx,ctx,{employmentId:f.employmentId,date:f.date,mode:'cash',calculationId:claims[0].calculationId,payrollBatchId:batchId}))).rejects.toThrow();
});
