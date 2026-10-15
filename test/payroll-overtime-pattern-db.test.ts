/** Real canonical source -> cash claim -> Payroll kernel regressions. Written during hold; not executed. */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {randomUUID} from 'node:crypto';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,setSetting,type Base} from './harness';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {requirePackFor} from '../localization/registry';
import {createBatch,createAdditionalRun,setPayrollConfig,disburseNetAcrossCycles,createPayComponent,setPayrollInput,prefillOvertimeFromAttendance,generatePayslips,closeBatch,deleteDraftBatch,createPolicy,assignPolicy,overtimePatternTransferOptions,transferOvertimePatternToPayroll,readPayrollOvertimePatternCashTx,readPayrollOvertimeCoverageTx} from '../packs/payroll/service';
import {checkIn,checkOut,setAttendancePolicy,saveOvertimePatternDraft,validateOvertimePatternActivation,activateOvertimePattern,saveOvertimePatternAssignment,createOvertimeCalculationOwner,canonicalOvertimeInputTx,readOvertimeCalculationTx,readOvertimeSettlementForDayTx} from '../packs/attendance/service';
import {todayInKualaLumpur} from '../lib/hr-date';
import {evaluateOvertimePattern,evaluateOvertimePatternDuration,validateOvertimeInput} from '../lib/overtime-pattern-evaluate';
import {parseRecordedOvertimeEvaluation} from '../lib/overtime-pattern-result';
import type {OvertimePattern} from '../lib/overtime-pattern-model';
let b:Base;const day=()=>todayInKualaLumpur();
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'attendance','active');await setModule(b.tenantId,'payroll','active');await setModule(b.tenantId,'typed_pay_components',null);await setSetting(b.tenantId,'payroll.individual_txn_pay_enabled',false);});
async function fixture(amount='60',options:{salary?:number;cappedBase?:boolean}={}){
 const ctx=await entitledCtx(b);
 const e=await hireEmployee(ctx,{person:{fullName:'Fictional formula cash worker',primaryEmail:'fictional-formula-cash@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 await setCompensation(ctx,{employmentId:e.employmentId,basicSalary:options.salary??3000,monthlyAllowance:0,effectiveFrom:'2024-01-01'});
 await setStatutoryProfileMY(ctx,{personId:e.personId,icNumber:'900101011234'});
 await setAttendancePolicy(ctx,{companyId:b.companyId,workStart:'09:00',workEnd:'17:00',breakMinutes:0,lateAfter:'09:00',halfDayBefore:'13:00',workingDays:[1,2,3,4,5,6,7]});
 // Clock the legacy day BEFORE a formula assignment; prefill proves the duplicate aggregate existed.
 await checkIn(ctx,{employmentId:e.employmentId,date:day(),time:'09:00'});await checkOut(ctx,{employmentId:e.employmentId,date:day(),time:'19:00'});
 const batch=await createBatch(ctx,{companyId:b.companyId,payPeriod:day().slice(0,7)});await prefillOvertimeFromAttendance(ctx,{batchId:batch.batchId});
 const pack=requirePackFor('MY'),seed=pack.payComponents.defaults.find(x=>x.code===pack.payComponents.backfillCodes.overtime)!;
 const earning=await createPayComponent(ctx,{...seed,code:'FORMULA_'+randomUUID().slice(0,8),name:'Configured formula overtime'});
 const definition:OvertimePattern={v:1,currency:{code:'MYR',minorScale:2},definitions:[],eligibilityBasis:'day',durationAllocation:'latest',eligibility:{id:'eligible',type:'constant',value:true},eligibleMinutes:{id:'minutes',type:'literal',unit:'minutes',value:'120'},durationCap:null,durationRounding:null,deductions:[],rates:[{id:'rate',name:'Fixture flat payment',description:'Fictional configured rate',priority:1,when:{id:'when',type:'constant',value:true},timeBand:null,accumulation:'day',tierMode:'marginal',tiers:[{id:'tier',from:'0',to:null,mapping:{earningItemId:earning.id,currency:'MYR'},payment:{method:'flat',basis:'day',chargeId:'day',amount:{id:'amount',type:'literal',unit:'money',currency:'MYR',value:amount}}}]}],paymentCap:null,moneyRounding:{stage:'dayMapping',mode:'halfUp'}};
 if(options.cappedBase)definition.rates[0].tiers[0].payment={method:'hourly',rate:{id:'hourly',type:'hourlyRate',unit:'moneyPerHour',base:{id:'selected_base_cap',type:'min',unit:'money',left:{id:'salary',type:'field',unit:'money',field:'basicSalary'},right:{id:'chosen_cap',type:'literal',unit:'money',currency:'MYR',value:'4000'}},divisorMinutes:{id:'divisor',type:'literal',unit:'minutes',value:'12480'}},multiplier:{id:'multiplier',type:'literal',unit:'scalar',value:'1.5'}};
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
 it('pays mixed unassigned legacy and selected formula days once each',async()=>{
  const f=await fixture();const other=todayInKualaLumpur(new Date(Date.now()-86400000));
  if(other.slice(0,7)!==day().slice(0,7))await setPayrollConfig(f.ctx,{companyId:b.companyId,overtimeCutOffDay:2});
  await checkIn(f.ctx,{employmentId:f.e.employmentId,date:other,time:'09:00'});await checkOut(f.ctx,{employmentId:f.e.employmentId,date:other,time:'19:00'});
  await prefillOvertimeFromAttendance(f.ctx,{batchId:f.batch.batchId});const input=(await owner.db.select().from(s.payrollInput).where(eq(s.payrollInput.batchId,f.batch.batchId)))[0];const legacy=Number(input.overtimeAmount);expect(legacy).toBeGreaterThan(0);
  await transferOvertimePatternToPayroll(f.ctx,f.transfer);await generatePayslips(f.ctx,{batchId:f.batch.batchId});expect(Number((await slip(f.batch.batchId)).overtimePay)).toBe(Math.round((legacy+60)*100)/100);
 });
 it('weights a weekly cycle by the formula source cash date after excluding legacy minutes for that day',async()=>{
  const f=await fixture();const policy=await createPolicy(f.ctx,{companyId:b.companyId,name:'Weekly formula cash',policyType:'monthly',config:{frequency:'weekly'}});await setPayrollConfig(f.ctx,{companyId:b.companyId,defaultPayrollPolicyId:policy.id});
  await transferOvertimePatternToPayroll(f.ctx,f.transfer);await generatePayslips(f.ctx,{batchId:f.batch.batchId});const paid=await slip(f.batch.batchId);
  const schedule=(paid.statutory as {paymentSchedule:{cycles:{seq:number;from:string;to:string;amount:number}[]}}).paymentSchedule.cycles;expect(schedule.length).toBeGreaterThan(1);
  const days=schedule.map(p=>(Date.parse(p.to+'T00:00:00Z')-Date.parse(p.from+'T00:00:00Z'))/86400000+1);
  const expected=disburseNetAcrossCycles({net:Number(paid.netPay),recurring:3000,overtime:60,unpaid:0,cycleDays:days,otMinutes:schedule.map(p=>day()>=p.from&&day()<=p.to?6000:0),unpaidDays:schedule.map(()=>0)});
  expect(schedule.map(p=>p.amount)).toEqual(expected);expect(Math.round(schedule.reduce((sum,p)=>sum+p.amount,0)*100)).toBe(Math.round(Number(paid.netPay)*100));
 });
 it('preserves independent manual OT and bonus while adding formula cash',async()=>{
  const f=await fixture();await setPayrollInput(f.ctx,{batchId:f.batch.batchId,employmentId:f.e.employmentId,overtimeAmount:25,bonusAmount:17});await transferOvertimePatternToPayroll(f.ctx,f.transfer);
  await generatePayslips(f.ctx,{batchId:f.batch.batchId});expect(await slip(f.batch.batchId)).toMatchObject({overtimePay:'85.00',bonus:'17.00'});
 });
 it('consumes retained obligations after Attendance module removal but denies a new transfer',async()=>{
  const f=await fixture();await transferOvertimePatternToPayroll(f.ctx,f.transfer);await setModule(b.tenantId,'attendance','disabled');const ctx=await entitledCtx(b);
  await expect(transferOvertimePatternToPayroll(ctx,f.transfer)).rejects.toThrow();await generatePayslips(ctx,{batchId:f.batch.batchId});expect((await slip(f.batch.batchId)).overtimePay).toBe('60.00');
 });
 it('pays an explicit contractual min(salary5000,chosenbase4000) formula without asserting statutory entitlement',async()=>{
  const f=await fixture('60',{salary:5000,cappedBase:true});const options=await overtimePatternTransferOptions(f.ctx,{employmentId:f.e.employmentId,date:day()});expect(options.calculation).toMatchObject({status:'ready',amountMinorUnits:'5769',transferable:true});
  await transferOvertimePatternToPayroll(f.ctx,f.transfer);await generatePayslips(f.ctx,{batchId:f.batch.batchId});const paid=await slip(f.batch.batchId);expect(paid.overtimePay).toBe('57.69');
  const evidence=(paid.statutory as {overtimePatternCash:{sourceLines:{floorEvidence:{countryMinimumApplicable:boolean;minimumMinorUnits:string}}[]}}).overtimePatternCash;
  expect(evidence.sourceLines[0].floorEvidence).toMatchObject({countryMinimumApplicable:false,minimumMinorUnits:'0'});
 });
 it('rejects a formula below the country owner floor without silently changing its configured amount',async()=>{
  const f=await fixture('0.01');await expect(transferOvertimePatternToPayroll(f.ctx,f.transfer)).rejects.toMatchObject({code:'statutoryFloor'});expect((await withTenant(f.ctx,tx=>readOvertimeSettlementForDayTx(tx,f.ctx,f.transfer)))?.settlement).toBeNull();
 });
 it('rechecks mapping treatment and source freshness on retained consumption',async()=>{
  const f=await fixture();await transferOvertimePatternToPayroll(f.ctx,f.transfer);await owner.db.update(s.payComponent).set({includedInEpf:true}).where(eq(s.payComponent.id,f.earning.id));
  await expect(withTenant(f.ctx,tx=>readPayrollOvertimePatternCashTx(tx,f.ctx,{batchId:f.batch.batchId}))).rejects.toMatchObject({code:'mapping'});
 });
 it('refuses stale source digest and never publishes a partial payslip',async()=>{
  const f=await fixture();await transferOvertimePatternToPayroll(f.ctx,f.transfer);await withTenant(f.ctx,tx=>tx.update(s.attendance).set({workedMinutes:599}).where(eq(s.attendance.employmentId,f.e.employmentId)));
  await expect(generatePayslips(f.ctx,{batchId:f.batch.batchId})).rejects.toMatchObject({code:'stale'});expect(await slip(f.batch.batchId)).toBeUndefined();
 });
 it('applies a monthly cash cap once across manual and formula inputs',async()=>{
  const f=await fixture();const policy=await createPolicy(f.ctx,{companyId:b.companyId,name:'Mixed amount cap',policyType:'monthly',config:{overtime:{maxAmount:50}}});await assignPolicy(f.ctx,{employmentId:f.e.employmentId,policyId:policy.id});await setPayrollInput(f.ctx,{batchId:f.batch.batchId,employmentId:f.e.employmentId,overtimeAmount:25});await transferOvertimePatternToPayroll(f.ctx,f.transfer);await generatePayslips(f.ctx,{batchId:f.batch.batchId});expect((await slip(f.batch.batchId)).overtimePay).toBe('50.00');
 });
 it('refuses nonregular, out-of-period and out-of-scope runs before any cash reservation',async()=>{
  await setModule(b.tenantId,'multi_cycle_payroll','active');
  const f=await fixture();const off=await createAdditionalRun(f.ctx,{companyId:b.companyId,payPeriod:day().slice(0,7),runType:'off_cycle'});
  await expect(transferOvertimePatternToPayroll(f.ctx,{...f.transfer,batchId:off.batchId})).rejects.toMatchObject({code:'unsupportedRun'});
  const futureMonth=new Date(day().slice(0,7)+'-01T00:00:00Z');futureMonth.setUTCMonth(futureMonth.getUTCMonth()+2);
  const future=await createBatch(f.ctx,{companyId:b.companyId,payPeriod:futureMonth.toISOString().slice(0,7)});
  await expect(transferOvertimePatternToPayroll(f.ctx,{...f.transfer,batchId:future.batchId})).rejects.toMatchObject({code:'coverage'});
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
 it('rolls back the formula claim release when actual batch deletion fails late',async()=>{
  const f=await fixture(),claim=await transferOvertimePatternToPayroll(f.ctx,f.transfer);
  await owner.client.unsafe("create function public.board16_fail_formula_batch_delete() returns trigger language plpgsql as $$begin raise exception 'Controlled late batch delete failure' using errcode='23514';end$$");
  await owner.client.unsafe('create trigger board16_fail_formula_batch_delete before delete on payroll_batch for each row execute function public.board16_fail_formula_batch_delete()');
  try{
   await expect(deleteDraftBatch(f.ctx,{batchId:f.batch.batchId})).rejects.toMatchObject({cause:expect.objectContaining({code:'23514',message:'Controlled late batch delete failure'})});
   const [retained]=await owner.db.select().from(s.overtimeSourceSettlement).where(eq(s.overtimeSourceSettlement.id,claim.settlementId));
   expect(retained.releasedAt).toBeNull();expect(retained.payrollBatchId).toBe(f.batch.batchId);
   expect(retained.ownerReference).toEqual({type:'payroll_batch',id:f.batch.batchId});
   expect((await owner.db.select().from(s.payrollBatch).where(eq(s.payrollBatch.id,f.batch.batchId)))[0].status).toBe('draft');
   expect((await transferOvertimePatternToPayroll(f.ctx,f.transfer)).status).toBe('unchanged');
  }finally{
   await owner.client.unsafe('drop trigger board16_fail_formula_batch_delete on payroll_batch');
   await owner.client.unsafe('drop function public.board16_fail_formula_batch_delete()');
  }
 });
 it('refuses unresolved selected formula days rather than treating their legacy minutes as payable',async()=>{
  const f=await fixture();await withTenant(f.ctx,tx=>tx.update(s.attendance).set({calcTrace:{overtimePattern:{status:'refused',reason:'sourceUnavailable'}} as never}).where(eq(s.attendance.employmentId,f.e.employmentId)));
  const coverage=await withTenant(f.ctx,tx=>readPayrollOvertimeCoverageTx(tx,f.ctx,{companyId:b.companyId,from:day(),to:day()}));expect(coverage.keys.has(f.e.employmentId+'|'+day())).toBe(true);
  await expect(generatePayslips(f.ctx,{batchId:f.batch.batchId})).rejects.toMatchObject({code:'unavailable'});
 });
 it('refuses forged expected revisions and cross-tenant sources before reserving any cash',async()=>{
  const f=await fixture();await expect(transferOvertimePatternToPayroll(f.ctx,{...f.transfer,expectedSourceRevision:f.transfer.expectedSourceRevision+1})).rejects.toMatchObject({code:'stale'});
  const other=await seedBase();await setModule(other.tenantId,'attendance','active');await setModule(other.tenantId,'payroll','active');await expect(transferOvertimePatternToPayroll(adminCtx(other),f.transfer)).rejects.toThrow();expect((await withTenant(f.ctx,tx=>readOvertimeSettlementForDayTx(tx,f.ctx,f.transfer)))?.settlement).toBeNull();
 });
});

/** Raw SQL is deliberately stronger than the action API: these tests prove the financial consumer
 * independently rejects tampering, without pretending SQL attests the opaque JS publication path. */
describe('independent pinned financial verification',()=>{
 async function forge(f:Awaited<ReturnType<typeof fixture>>,kind:'amount'|'inputs'|'assignment'){
  const read=await withTenant(f.ctx,tx=>readOvertimeCalculationTx(tx,f.ctx,{employmentId:f.e.employmentId,date:day()}));
  if(!read?.calculation||!read.evidence)throw new Error('Expected real recorded fixture');
  const c=read.calculation,inputs=validateOvertimeInput(read.evidence.inputs),payload=structuredClone(read.evidence.evidence) as Record<string,unknown>;
  let versionId=c.versionId,assignmentId=c.assignmentId;
  if(kind==='assignment'){
   const peer=await hireEmployee(f.ctx,{person:{fullName:'Fictional other assignment worker',primaryEmail:'fictional-other-assignment@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
   const saved=await saveOvertimePatternDraft(f.ctx,{draft:{code:'OTHER_'+randomUUID().slice(0,8),creationCompanyId:b.companyId,companyIds:[b.companyId],name:'Only the other employee',definition:f.definition}});
   const check=await validateOvertimePatternActivation(f.ctx,{versionId:saved.versionId,expectedRevision:saved.revision});if(!check.validationDigest)throw new Error('Expected valid alternative fixture');
   await activateOvertimePattern(f.ctx,{versionId:saved.versionId,expectedRevision:saved.revision,validationDigest:check.validationDigest,effectiveFrom:day()});
   const assigned=await saveOvertimePatternAssignment(f.ctx,{versionId:saved.versionId,target:{type:'individual',employmentIds:[peer.employmentId]},priority:2,from:day(),to:null});versionId=saved.versionId;assignmentId=assigned.assignmentId;
  }
  if(!versionId||!assignmentId)throw new Error('Expected immutable formula binding');inputs.patternVersionId=versionId;inputs.assignmentId=assignmentId;
  if(kind==='inputs'){const actual=inputs.facts.actualWorkingMinutes;if(actual?.state!=='known')throw new Error('Expected measured actual minutes');actual.value='601';}
  const evaluation=kind==='amount'?parseRecordedOvertimeEvaluation(payload.evaluation):evaluateOvertimePattern(f.definition,inputs);
  if(!evaluation||evaluation.status!=='ready')throw new Error('Expected ready tampering control');
  if(kind==='amount'){
   evaluation.amountMinorUnits=(BigInt(evaluation.amountMinorUnits)+BigInt('10000')).toString();const line=evaluation.lines[0];if(!line)throw new Error('Expected earning line');
   line.amountMinorUnits=(BigInt(line.amountMinorUnits)+BigInt('10000')).toString();
   for(const amount of [line.gross,line.adjusted])amount.numerator=(BigInt(amount.numerator)+BigInt(amount.denominator)*BigInt('100')).toString();
  }
  payload.evaluation=evaluation;payload.duration=evaluateOvertimePatternDuration(f.definition,inputs);
  const userId=await createAppUser(b.tenantId,f.e.personId,'employee'),self={...f.ctx,userId,roles:['employee']};
  const calculationId=randomUUID(),revision=read.source.revision+1;
  await withTenant(self,async tx=>{
   const [role]=await tx.execute(sql`select current_user as name,rolsuper,rolbypassrls,app.can_admin_payroll_for(${b.companyId}::uuid) as financial from pg_roles where rolname=current_user`) as unknown as {name:string;rolsuper:boolean;rolbypassrls:boolean;financial:boolean}[];
   expect(role).toEqual({name:'ai_hr_app',rolsuper:false,rolbypassrls:false,financial:false});
   await tx.insert(s.attendanceOvertimeCalculation).values({...c,id:calculationId,versionId,assignmentId,ordinal:revision,reason:'Raw self SQL tampering regression'});
   await tx.insert(s.attendanceOvertimeCalculationEvidence).values({tenantId:b.tenantId,companyId:b.companyId,calculationId,inputs:JSON.parse(JSON.stringify(inputs)),evidence:JSON.parse(JSON.stringify(payload))});
   await tx.insert(s.attendanceOvertimeLine).values(evaluation.lines.map((line,sequence)=>({tenantId:b.tenantId,companyId:b.companyId,calculationId,lineKey:line.id,sequence,componentId:line.mapping.earningItemId,amountMinorUnits:line.amountMinorUnits,evidence:JSON.parse(JSON.stringify(line))})));
   await tx.update(s.attendanceOvertimeSource).set({currentCalculationId:calculationId,revision}).where(eq(s.attendanceOvertimeSource.id,read.source.id));
  });
  return {read,transfer:{...f.transfer,expectedCalculationId:calculationId,expectedSourceRevision:revision}};
 }
 it('verifies the retained definition without repricing to a newer higher-priority assignment',async()=>{
  const f=await fixture(),definition=structuredClone(f.definition);definition.rates[0].tiers[0].payment={method:'flat',basis:'day',chargeId:'day',amount:{id:'new_amount',type:'literal',unit:'money',currency:'MYR',value:'90'}};
  const saved=await saveOvertimePatternDraft(f.ctx,{draft:{code:'NEW_'+randomUUID().slice(0,8),creationCompanyId:b.companyId,companyIds:[b.companyId],name:'Later deliberate policy',definition}});
  const check=await validateOvertimePatternActivation(f.ctx,{versionId:saved.versionId,expectedRevision:saved.revision});if(!check.validationDigest)throw new Error('Expected valid new policy');
  await activateOvertimePattern(f.ctx,{versionId:saved.versionId,expectedRevision:saved.revision,validationDigest:check.validationDigest,effectiveFrom:day()});
  await saveOvertimePatternAssignment(f.ctx,{versionId:saved.versionId,target:{type:'individual',employmentIds:[f.e.employmentId]},priority:2,from:day(),to:null});
  await transferOvertimePatternToPayroll(f.ctx,f.transfer);await generatePayslips(f.ctx,{batchId:f.batch.batchId});expect((await slip(f.batch.batchId)).overtimePay).toBe('60.00');
 });
 for(const kind of ['amount','inputs','assignment'] as const)it('refuses raw app-role forged '+kind+' without changing recorded history or paying',async()=>{
  const f=await fixture(),forged=await forge(f,kind),before=await withTenant(f.ctx,tx=>readOvertimeCalculationTx(tx,f.ctx,{employmentId:f.e.employmentId,date:day()}));
  await expect(transferOvertimePatternToPayroll(f.ctx,forged.transfer)).rejects.toMatchObject(kind==='assignment'?{code:'unavailable'}:{code:'stale'});
  expect(await withTenant(f.ctx,tx=>readOvertimeCalculationTx(tx,f.ctx,{employmentId:f.e.employmentId,date:day()}))).toEqual(before);
  expect((await withTenant(f.ctx,tx=>readOvertimeSettlementForDayTx(tx,f.ctx,f.transfer)))?.settlement).toBeNull();expect(await slip(f.batch.batchId)).toBeUndefined();
  expect((await owner.db.select().from(s.attendanceOvertimeCalculation).where(eq(s.attendanceOvertimeCalculation.id,forged.read.calculation!.id)))[0]).toEqual(forged.read.calculation);
 });
});
