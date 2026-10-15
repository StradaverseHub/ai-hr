/** Real canonical source -> cash claim -> Payroll kernel regressions. Written during hold; not executed. */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {adminCtx,closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,setSetting,type Base} from './harness';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {requirePackFor} from '../localization/registry';
import {createBatch,createAdditionalRun,createPayComponent,setPayrollInput,prefillOvertimeFromAttendance,generatePayslips,closeBatch,deleteDraftBatch,createPolicy,assignPolicy,overtimePatternTransferOptions,transferOvertimePatternToPayroll,readPayrollOvertimePatternCashTx,readPayrollOvertimeCoverageTx} from '../packs/payroll/service';
import {checkIn,checkOut,setAttendancePolicy,saveOvertimePatternDraft,validateOvertimePatternActivation,activateOvertimePattern,saveOvertimePatternAssignment,createOvertimeCalculationOwner,canonicalOvertimeInputTx,readOvertimeCalculationTx,readOvertimeSettlementForDayTx} from '../packs/attendance/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {OvertimePattern} from '../lib/overtime-pattern-model';
let b:Base;const day=()=>todayInKualaLumpur();
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'attendance','active');await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'typed_pay_components',null);await setSetting(b.tenantId,'payroll.individual_txn_pay_enabled',false);});
async function fixture(amount='60'){
 const ctx=await entitledCtx(b);
 const e=await hireEmployee(ctx,{person:{fullName:'Fictional formula cash worker'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 await setCompensation(ctx,{employmentId:e.employmentId,basicSalary:3000,monthlyAllowance:0,effectiveFrom:'2024-01-01'});
 await setStatutoryProfileMY(ctx,{personId:e.personId,icNumber:'900101011234'});
 await setAttendancePolicy(ctx,{companyId:b.companyId,workStart:'09:00',workEnd:'17:00',breakMinutes:0,lateAfter:'09:00',halfDayBefore:'13:00',workingDays:[1,2,3,4,5,6,7]});
 // Clock the legacy day BEFORE a formula assignment; prefill proves the duplicate aggregate existed.
 await checkIn(ctx,{employmentId:e.employmentId,date:day(),time:'09:00'});await checkOut(ctx,{employmentId:e.employmentId,date:day(),time:'19:00'});
 const batch=await createBatch(ctx,{companyId:b.companyId,payPeriod:day().slice(0,7)});await prefillOvertimeFromAttendance(ctx,{batchId:batch.batchId});
 const pack=requirePackFor('MY'),seed=pack.payComponents.defaults.find(x=>x.code===pack.payComponents.backfillCodes.overtime)!;
 const earning=await createPayComponent(ctx,{...seed,code:'FORMULA_'+randomUUID().slice(0,8),name:'Configured formula overtime'});
 const definition:OvertimePattern={v:1,currency:{code:'MYR',minorScale:2},definitions:[],eligibilityBasis:'day',durationAllocation:'latest',eligibility:{id:'eligible',type:'constant',value:true},eligibleMinutes:{id:'minutes',type:'literal',unit:'minutes',value:'120'},durationCap:null,durationRounding:null,deductions:[],rates:[{id:'rate',name:'Fixture flat payment',description:'Fictional configured rate',priority:1,when:{id:'when',type:'constant',value:true},timeBand:null,accumulation:'day',tierMode:'marginal',tiers:[{id:'tier',from:'0',to:null,mapping:{earningItemId:earning.id,currency:'MYR'},payment:{method:'flat',basis:'day',chargeId:'day',amount:{id:'amount',type:'literal',unit:'money',currency:'MYR',value:amount}}}]}],paymentCap:null,moneyRounding:{stage:'dayMapping',mode:'halfUp'}};
 const saved=await saveOvertimePatternDraft(ctx,{draft:{code:'OT_'+randomUUID().slice(0,8),creationCompanyId:b.companyId,companyIds:[b.companyId],name:'Formula payroll fixture',description:'Fictional',definition}});
 const validation=await validateOvertimePatternActivation(ctx,{versionId:saved.versionId,expectedRevision:saved.revision});expect(validation.issues).toEqual([]);
 await activateOvertimePattern(ctx,{versionId:saved.versionId,expectedRevision:saved.revision,validationDigest:validation.validationDigest!,effectiveFrom:day()});
 await saveOvertimePatternAssignment(ctx,{versionId:saved.versionId,target:{type:'individual',employmentIds:[e.employmentId]},priority:1,from:day(),to:null});
 const api=createOvertimeCalculationOwner(canonicalOvertimeInputTx);
 const calculation=await withTenant(ctx,async tx=>{const prepared=await api.prepareTx(tx,ctx,{employmentId:e.employmentId,date:day()});const read=await readOvertimeCalculationTx(tx,ctx,{employmentId:e.employmentId,date:day()});return api.recordTx(tx,ctx,{prepared,expectedCurrentRevision:read!.source.revision});});
 if(calculation.status!=='recorded'||!calculation.evaluation||calculation.evaluation.status!=='ready')throw new Error('Canonical fixture must produce a ready formula');
 const transfer={employmentId:e.employmentId,date:day(),expectedCalculationId:calculation.calculationId,expectedSourceRevision:calculation.revision,batchId:batch.batchId,reason:'Fictional verified transfer'};
 return {ctx,e,batch,transfer,earning,definition};
}
async function slip(batchId:string){return (await owner.db.select().from(s.payslip).where(eq(s.payslip.batchId,batchId)))[0];}
describe('formula money is an actual canonical Payroll input',()=>{
 it('removes the old attendance aggregate, pays once with transaction flag off, and keeps an identical retry unchanged',async()=>{
  const f=await fixture();const before=(await owner.db.select().from(s.payrollInput).where(eq(s.payrollInput.batchId,f.batch.batchId)))[0];expect(Number(before.overtimeAmount)).toBeGreaterThan(0);
  const first=await transferOvertimePatternToPayroll(f.ctx,f.transfer);expect(first.status).toBe('transferred');expect(await transferOvertimePatternToPayroll(f.ctx,f.transfer)).toMatchObject({status:'unchanged',settlementId:first.settlementId});
  const after=(await owner.db.select().from(s.payrollInput).where(eq(s.payrollInput.id,before.id)))[0];expect(after.overtimeAmount).toBe('0.00');
  await generatePayslips(f.ctx,{batchId:f.batch.batchId});expect((await slip(f.batch.batchId)).overtimePay).toBe('60.00');expect((await slip(f.batch.batchId)).statutory).toHaveProperty('overtimePatternCash');expect((await slip(f.batch.batchId)).statutory).toMatchObject({componentLines:expect.arrayContaining([expect.objectContaining({name:'Configured formula overtime',amount:60,buckets:[{bucket:'ot',amount:60}],epf:false})])});
 });
 it('preserves independent manual OT and bonus while adding formula cash',async()=>{
  const f=await fixture();await setPayrollInput(f.ctx,{batchId:f.batch.batchId,employmentId:f.e.employmentId,overtimeAmount:25,bonusAmount:17});await transferOvertimePatternToPayroll(f.ctx,f.transfer);
  await generatePayslips(f.ctx,{batchId:f.batch.batchId});expect(await slip(f.batch.batchId)).toMatchObject({overtimePay:'85.00',bonus:'17.00'});
 });
 it('consumes retained obligations after Attendance module removal but denies a new transfer',async()=>{
  const f=await fixture();await transferOvertimePatternToPayroll(f.ctx,f.transfer);await setModule(b.tenantId,'attendance','disabled');const ctx=await entitledCtx(b);
  await expect(transferOvertimePatternToPayroll(ctx,f.transfer)).rejects.toThrow();await generatePayslips(ctx,{batchId:f.batch.batchId});expect((await slip(f.batch.batchId)).overtimePay).toBe('60.00');
 });
 it('rejects a formula below the country owner floor without silently changing its configured amount',async()=>{
  const f=await fixture('0.01');await expect(transferOvertimePatternToPayroll(f.ctx,f.transfer)).rejects.toMatchObject({code:'statutoryFloor'});expect((await withTenant(f.ctx,tx=>readOvertimeSettlementForDayTx(tx,f.ctx,f.transfer)))?.settlement).toBeNull();
 });
 it('rechecks mapping treatment and source freshness on retained consumption',async()=>{
  const f=await fixture();await transferOvertimePatternToPayroll(f.ctx,f.transfer);await owner.db.update(s.payComponent).set({includedInEpf:true}).where(eq(s.payComponent.id,f.earning.id));
  await expect(withTenant(f.ctx,tx=>readPayrollOvertimePatternCashTx(tx,f.ctx,{batchId:f.batch.batchId}))).rejects.toMatchObject({code:'mapping'});
 });
 it('refuses stale source digest and never publishes a partial payslip',async()=>{
  const f=await fixture();await transferOvertimePatternToPayroll(f.ctx,f.transfer);await owner.db.update(s.attendance).set({workedMinutes:599}).where(eq(s.attendance.employmentId,f.e.employmentId));
  await expect(generatePayslips(f.ctx,{batchId:f.batch.batchId})).rejects.toMatchObject({code:'stale'});expect(await slip(f.batch.batchId)).toBeUndefined();
 });
 it('applies a monthly cash cap once across manual and formula inputs',async()=>{
  const f=await fixture();const policy=await createPolicy(f.ctx,{companyId:b.companyId,name:'Mixed amount cap',policyType:'monthly',config:{overtime:{maxAmount:50}}});await assignPolicy(f.ctx,{employmentId:f.e.employmentId,policyId:policy.id});await setPayrollInput(f.ctx,{batchId:f.batch.batchId,employmentId:f.e.employmentId,overtimeAmount:25});await transferOvertimePatternToPayroll(f.ctx,f.transfer);await generatePayslips(f.ctx,{batchId:f.batch.batchId});expect((await slip(f.batch.batchId)).overtimePay).toBe('50.00');
 });
 it('refuses nonregular, out-of-period and out-of-scope runs before any cash reservation',async()=>{
  const f=await fixture();const off=await createAdditionalRun(f.ctx,{companyId:b.companyId,payPeriod:day().slice(0,7),runType:'off_cycle'});
  await expect(transferOvertimePatternToPayroll(f.ctx,{...f.transfer,batchId:off.batchId})).rejects.toMatchObject({code:'unsupportedRun'});
  await owner.db.update(s.payrollBatch).set({scope:{employmentIds:[randomUUID()]}}).where(eq(s.payrollBatch.id,f.batch.batchId));
  await expect(transferOvertimePatternToPayroll(f.ctx,f.transfer)).rejects.toMatchObject({code:'coverage'});
  expect((await withTenant(f.ctx,tx=>readOvertimeSettlementForDayTx(tx,f.ctx,f.transfer)))?.settlement).toBeNull();
 });
 it('refuses unknown manual hours under the combined monthly hours cap without partial payslips',async()=>{
  const f=await fixture();const policy=await createPolicy(f.ctx,{companyId:b.companyId,name:'Unknown manual hours',policyType:'monthly',config:{overtime:{maxHoursPerMonth:1}}});await assignPolicy(f.ctx,{employmentId:f.e.employmentId,policyId:policy.id});await setPayrollInput(f.ctx,{batchId:f.batch.batchId,employmentId:f.e.employmentId,overtimeAmount:25});await transferOvertimePatternToPayroll(f.ctx,f.transfer);
  await expect(generatePayslips(f.ctx,{batchId:f.batch.batchId})).rejects.toMatchObject({code:'unknownHours'});expect(await slip(f.batch.batchId)).toBeUndefined();
 });
 it('revalidates mapped treatment at close and keeps the processed run unclosed on refusal',async()=>{
  const f=await fixture();await transferOvertimePatternToPayroll(f.ctx,f.transfer);await generatePayslips(f.ctx,{batchId:f.batch.batchId});
  await owner.db.update(s.payComponent).set({includedInEpf:true}).where(eq(s.payComponent.id,f.earning.id));await expect(closeBatch(f.ctx,{batchId:f.batch.batchId})).rejects.toMatchObject({code:'mapping'});
  expect((await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,f.batch.batchId)))[0].status).toBe('processed');
 });
 it('serializes concurrent identical transfers into one cash settlement',async()=>{
  const f=await fixture();const results=await Promise.all([transferOvertimePatternToPayroll(f.ctx,f.transfer),transferOvertimePatternToPayroll(f.ctx,f.transfer)]);
  expect(new Set(results.map(r=>r.settlementId)).size).toBe(1);expect(results.map(r=>r.status).sort()).toEqual(['transferred','unchanged']);
 });
 it('releases a draft settlement on canonical deletion and retains its immutable owner reference',async()=>{
  const f=await fixture();const claim=await transferOvertimePatternToPayroll(f.ctx,f.transfer);await deleteDraftBatch(f.ctx,{batchId:f.batch.batchId});const row=(await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.id,claim.settlementId)))[0];expect(row.releasedAt).not.toBeNull();expect(row.payrollBatchId).toBeNull();expect(row.ownerReference).toEqual({type:'payroll_batch',id:f.batch.batchId});
 });
 it('refuses unresolved selected formula days rather than treating their legacy minutes as payable',async()=>{
  const f=await fixture();await owner.db.update(s.attendance).set({calcTrace:{overtimePattern:{status:'refused',reason:'sourceUnavailable'}} as never}).where(eq(s.attendance.employmentId,f.e.employmentId));
  const coverage=await withTenant(f.ctx,tx=>readPayrollOvertimeCoverageTx(tx,f.ctx,{companyId:b.companyId,from:day(),to:day()}));expect(coverage.keys.has(f.e.employmentId+'|'+day())).toBe(true);
  await expect(generatePayslips(f.ctx,{batchId:f.batch.batchId})).rejects.toMatchObject({code:'unavailable'});
 });
 it('refuses forged expected revisions and cross-tenant sources before reserving any cash',async()=>{
  const f=await fixture();await expect(transferOvertimePatternToPayroll(f.ctx,{...f.transfer,expectedSourceRevision:f.transfer.expectedSourceRevision+1})).rejects.toMatchObject({code:'stale'});
  const other=await seedBase();await setModule(other.tenantId,'attendance','active');await setModule(other.tenantId,'payroll','active');await expect(transferOvertimePatternToPayroll(adminCtx(other),f.transfer)).rejects.toThrow();expect((await withTenant(f.ctx,tx=>readOvertimeSettlementForDayTx(tx,f.ctx,f.transfer)))?.settlement).toBeNull();
 });
});
