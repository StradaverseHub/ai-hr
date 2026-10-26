/** Positive real canonical records, authored UNRUN. No mocked readers, provider calls or model facts.
 * These cases establish named module projections only; they are not whole-roadmap acceptance.
 */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee,setReportingLine,endReportingLine} from '../core/org';
import {seedPayComponentCatalog,listPayComponents,setEmploymentPayComponent,upsertPayComponent} from '../core/pay-components';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {createBatch,generatePayslips,closeBatch} from '../core/payroll';
import {createClaimType,submitClaim,decideClaim} from '../core/claims';
import {checkIn,checkOut} from '../core/attendance';
import {setRestDay} from '../core/roster';
import {setToilPolicy,accrueToil} from '../core/toil';
import {createOnboardingCase,tickStep,getMyOnboarding} from '../packs/lifecycle/service';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {loadCanonicalModuleJob,type CanonicalModuleJobView} from '../core/workspace-module-jobs';
import {recordedPayrollComparisonCurrency} from '../lib/payroll-comparison-source';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {AgentModuleCode} from '../lib/ai/module-agents';
import type {JobCard,JobFactField} from '../lib/ai/module-jobs';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();base=await seedBase();for(const module of ['assistant','payroll','multi_cycle_payroll','typed_pay_components','claims','toil','attendance','org','employees','lifecycle'])await setModule(base.tenantId,module,'active');});
type Subject=Awaited<ReturnType<typeof hireEmployee>>&{email:string;name:string;companyId:string};
async function fixture(){const admin=adminCtx(base);
 const [company]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Foreign fixture employer',companyLabel:'FOREIGN',currency:'MYR'}).returning({id:schema.company.id});
 const [department]=await owner.db.insert(schema.department).values({tenantId:base.tenantId,companyId:company.id,name:'Foreign fixture department'}).returning({id:schema.department.id});
 const hire=async(name:string,companyId=base.companyId,departmentId=base.deptA,manager?:string):Promise<Subject>=>{
  const email=randomUUID()+'@fixture.test',result=await hireEmployee(admin,{person:{fullName:name,primaryEmail:email},companyId,departmentId,employmentType:'full_time',hiredOn:'2020-01-01',...(manager?{reportingManagerEmploymentId:manager}:{})});
  return {...result,email,name,companyId};
 };
 const mine=await hire('Canonical own person'),peer=await hire('PRIVATE_OTHER_PERSON'),foreign=await hire('PRIVATE_FOREIGN_PERSON',company.id,department.id);
 const userId=await createAppUser(base.tenantId,mine.personId,'employee');await grantAssistant(admin,{appUserId:userId});
 const ctx:SessionContext={...await entitledCtx(base,['employee']),userId,personId:mine.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 return {admin,ctx,mine,peer,foreign,hire};
}
function cards(view:CanonicalModuleJobView):readonly JobCard[]{expect(view.state).toBe('ready');if(view.state!=='ready')throw Error('Expected actual canonical job records.');expect(view.presentation.cards.length).toBeGreaterThan(0);return view.presentation.cards;}
const fact=(card:JobCard,field:JobFactField)=>card.facts.find(row=>row.field===field)?.value;
async function revoked(admin:SessionContext,ctx:SessionContext,module:AgentModuleCode){await revokeAssistant(admin,{appUserId:ctx.userId!});expect((await loadCanonicalModuleJob(ctx,{module})).state).toBe('unavailable');}

describe('real-record canonical job projection and current authorization',()=>{
 it('copies released kernel payroll and recorded currency exactly, excludes peer/foreign payslips and never computes net',async()=>{
  const f=await fixture();
  for(const [subject,basic,ic] of [[f.mine,7319,'910707030001'],[f.peer,9327,'910707030002'],[f.foreign,28417,'910707030003']] as const){
   await setCompensation(f.admin,{employmentId:subject.employmentId,basicSalary:basic,monthlyAllowance:0,effectiveFrom:'2020-01-01'});
   await setStatutoryProfileMY(f.admin,{personId:subject.personId,icNumber:ic});
  }
  await seedPayComponentCatalog(f.admin);const basic=(await listPayComponents(f.admin)).find(row=>row.code==='BASIC')!;
  await setEmploymentPayComponent(f.admin,{employmentId:f.mine.employmentId,componentId:basic.id,amount:7319,effectiveFrom:'2020-01-01'});
  await upsertPayComponent(f.admin,{label:'Canonical fixture allowance',code:'AGENT_ALLOWANCE',name:'Canonical fixture allowance',kind:'allowance',includedInEpf:true,includedInSocsoEis:true,includedInPcb:true,includedInHrdfBase:false,isNonPayable:false,prorates:true,roundingMethod:'none'});
  const allowance=(await listPayComponents(f.admin)).find(row=>row.code==='AGENT_ALLOWANCE')!;await setEmploymentPayComponent(f.admin,{employmentId:f.mine.employmentId,componentId:allowance.id,amount:120,effectiveFrom:'2020-01-01'});
  const {batchId}=await createBatch(f.admin,{companyId:base.companyId,payPeriod:'2026-03'});await generatePayslips(f.admin,{batchId});await closeBatch(f.admin,{batchId});
  const foreignBatch=await createBatch(f.admin,{companyId:f.foreign.companyId,payPeriod:'2026-03'});await generatePayslips(f.admin,{batchId:foreignBatch.batchId});await closeBatch(f.admin,{batchId:foreignBatch.batchId});
  const [mine]=await owner.db.select().from(schema.payslip).where(and(eq(schema.payslip.batchId,batchId),eq(schema.payslip.employmentId,f.mine.employmentId)));
  const others=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.employmentId,f.peer.employmentId));
  expect(mine).toBeTruthy();expect(others.length).toBeGreaterThan(0);
  expect(recordedPayrollComparisonCurrency(mine.statutory,base.companyId)).toBe('MYR');
  const view=await loadCanonicalModuleJob(f.ctx,{module:'payroll'}),rows=cards(view);expect(rows).toHaveLength(1);
  expect(fact(rows[0],'gross')).toBe(mine.grossPay);expect(fact(rows[0],'deductions')).toBe(mine.totalDeductions);expect(fact(rows[0],'net')).toBe(mine.netPay);expect(fact(rows[0],'currency')).toBe('MYR');
  expect(rows[0].href).toBe('/me/payslip/'+mine.id);for(const other of others)expect(JSON.stringify(view)).not.toContain(other.id);
  expect(JSON.stringify(view)).not.toContain('PRIVATE_OTHER_PERSON');expect(JSON.stringify(view)).not.toContain('Foreign fixture employer');
  const run=cards(await loadCanonicalModuleJob(f.ctx,{module:'multi_cycle_payroll'}));expect(run).toHaveLength(1);expect(fact(run[0],'period')).toBe('2026-03');expect(run[0].href).toBe('/me/payslip/'+mine.id);
  // Stored item lines are compared directly, never summed/re-derived by the Assistant.
  const statutory=mine.statutory as {componentLines?:{code?:string;name?:string;amount?:unknown}[]};expect(statutory.componentLines?.length).toBeGreaterThan(0);
  const items=cards(await loadCanonicalModuleJob(f.ctx,{module:'typed_pay_components'}));
  for(const item of items){const stored=statutory.componentLines!.find(line=>line.code===fact(item,'itemCode'));expect(stored).toBeTruthy();expect(fact(item,'amount')).toBe(stored!.amount);expect(fact(item,'currency')).toBe('MYR');}
  await revoked(f.admin,f.ctx,'payroll');
 });
 it('does not show an actual unclosed kernel payslip as a released record',async()=>{
  const f=await fixture();for(const subject of [f.mine,f.peer]){await setCompensation(f.admin,{employmentId:subject.employmentId,basicSalary:7319,monthlyAllowance:0,effectiveFrom:'2020-01-01'});await setStatutoryProfileMY(f.admin,{personId:subject.personId,icNumber:subject===f.mine?'910707030001':'910707030002'});}
  const {batchId}=await createBatch(f.admin,{companyId:base.companyId,payPeriod:'2026-03'});await generatePayslips(f.admin,{batchId});
  expect((await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId))).length).toBeGreaterThan(0);
  const view=await loadCanonicalModuleJob(f.ctx,{module:'payroll'});expect(view.state).toBe('ready');if(view.state==='ready')expect(view.presentation.cards).toEqual([]);
 });
 it('presents actual own claim lifecycle status/dates without amount, receipt or other-person claims',async()=>{
  const f=await fixture(),date=todayInKualaLumpur();
  for(const [subject,code,name,amount] of [[f.mine,'OWN','Canonical own expense',123.45],[f.peer,'PEER','PRIVATE_PEER_CLAIM',543.21],[f.foreign,'FOREIGN','PRIVATE_FOREIGN_CLAIM',987.65]] as const){
   const type=await createClaimType(f.admin,{code,name,defaultTaxable:false,requiresReceipt:false,maxReceiptAgeDays:36500});
   const result=await submitClaim(f.admin,{employmentId:subject.employmentId,claimTypeId:type.id,amount,incurredOn:date});
   if(subject===f.mine)await decideClaim(f.admin,{claimRequestId:result.id,decision:'approve'});
  }
  const view=await loadCanonicalModuleJob(f.ctx,{module:'claims'}),rows=cards(view);expect(rows).toHaveLength(1);expect(rows[0].title).toEqual({kind:'text',value:'Canonical own expense'});
  expect(fact(rows[0],'status')).toBe('approved');expect(fact(rows[0],'incurredOn')).toBe(date);expect(fact(rows[0],'decidedAt')).not.toBeNull();
  for(const privateField of ['123.45','543.21','987.65','PRIVATE_PEER_CLAIM','PRIVATE_FOREIGN_CLAIM','receipt','attachment'])expect(JSON.stringify(view)).not.toContain(privateField);
  await revoked(f.admin,f.ctx,'claims');
 });
 it('shows actual banked TOIL from attendance/roster engines with exact own credit values and no peer dates',async()=>{
  const f=await fixture(),approvedOn=new Date();
  for(const companyId of [base.companyId,f.foreign.companyId])await setToilPolicy(f.admin,{companyId,enabled:true,accrualBasis:'hours_worked',expiryDays:90,onExpiry:'convert_to_pay',allowFirstScheduleEligible:false,autoAccrueOnApproval:false,carryForwardAtYearEnd:false});
  let ownCredit:Awaited<ReturnType<typeof accrueToil>>|undefined;
  for(const [subject,date] of [[f.mine,'2026-07-04'],[f.peer,'2026-07-11'],[f.foreign,'2026-07-18']] as const){
   await setCompensation(f.admin,{employmentId:subject.employmentId,basicSalary:5000,monthlyAllowance:0,effectiveFrom:'2020-01-01'});
   await setRestDay(f.admin,{employmentId:subject.employmentId,shiftDate:date});await checkIn(f.admin,{employmentId:subject.employmentId,date,time:'08:00:00'});await checkOut(f.admin,{employmentId:subject.employmentId,date,time:'17:00:00'});
   const result=await accrueToil(f.admin,{employmentId:subject.employmentId,workedDate:date,approvedOn});if(subject===f.mine)ownCredit=result;
  }
  expect(ownCredit?.daysCredited).toBeGreaterThan(0);const view=await loadCanonicalModuleJob(f.ctx,{module:'toil'}),rows=cards(view);expect(rows).toHaveLength(2);
  expect(fact(rows[0],'activeCredit')).toBe(ownCredit!.daysCredited);expect(fact(rows[1],'date')).toBe('2026-07-04');expect(fact(rows[1],'credited')).toBe(ownCredit!.daysCredited);expect(fact(rows[1],'status')).toBe('active');
  expect(JSON.stringify(view)).not.toContain('2026-07-11');expect(JSON.stringify(view)).not.toContain('2026-07-18');await revoked(f.admin,f.ctx,'toil');
 });
 it('renders only actual current own reporting relationships, including a permitted cross-company manager rather than inventing a company wall',async()=>{
  const f=await fixture(),ownManager=await f.hire('Canonical own manager'),peerManager=await f.hire('PRIVATE_PEER_MANAGER');
  const ownLine=await setReportingLine(f.admin,{subordinateEmploymentId:f.mine.employmentId,managerEmploymentId:ownManager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
  await setReportingLine(f.admin,{subordinateEmploymentId:f.peer.employmentId,managerEmploymentId:peerManager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
  const first=await loadCanonicalModuleJob(f.ctx,{module:'org'});expect(cards(first)[0].title).toEqual({kind:'text',value:'Canonical own manager'});expect(JSON.stringify(first)).not.toContain('PRIVATE_PEER_MANAGER');
  await endReportingLine(f.admin,{reportingLineId:ownLine.reportingLineId,endDate:'2020-01-02'});
  await setReportingLine(f.admin,{subordinateEmploymentId:f.mine.employmentId,managerEmploymentId:f.foreign.employmentId,lineType:'administrative',validFrom:'2020-01-03'});
  const current=await loadCanonicalModuleJob(f.ctx,{module:'org'});expect(cards(current)[0].title).toEqual({kind:'text',value:'PRIVATE_FOREIGN_PERSON'});expect(JSON.stringify(current)).not.toContain('Canonical own manager');
  await revoked(f.admin,f.ctx,'org');
 });
 it('uses the real own-email onboarding checklist and current progress without cached case secrets or unrelated cases',async()=>{
  const f=await fixture();await owner.db.update(schema.company).set({companyLabel:'OWN'}).where(eq(schema.company.id,base.companyId));
  for(const subject of [f.mine,f.peer,f.foreign]){
   await createOnboardingCase(f.admin,{companyId:subject.companyId,fullName:subject.name,employeeNo:subject===f.mine?'OWN-CASE':subject===f.peer?'PEER-CASE':'FOREIGN-CASE',joinDate:todayInKualaLumpur(),newhireEmail:subject.email,
    jobTitle:'Canonical role',department:'Canonical department',supervisor:'PRIVATE_SUPERVISOR',laptopRequired:false,carparkRequired:false,costCentre:'PRIVATE_COST_CENTRE',nricPassport:'PRIVATE_IDENTITY',notes:'PRIVATE_CASE_NOTES'});
  }
  const before=await getMyOnboarding(f.ctx);expect(before).toBeTruthy();expect(before!.steps.length).toBeGreaterThan(0);
  await tickStep(f.admin,'onboarding',before!.number,'p_file');const actual=await getMyOnboarding(f.ctx);expect(actual!.steps.find(row=>row.key==='p_file')?.done).toBe(true);
  const view=await loadCanonicalModuleJob(f.ctx,{module:'lifecycle'}),rows=cards(view);expect(fact(rows[0],'progressDone')).toBe(actual!.progress.done);expect(fact(rows[0],'progressTotal')).toBe(actual!.progress.total);expect(fact(rows[0],'progressPercent')).toBe(actual!.progress.percent);
  const label=actual!.steps.find(row=>row.key==='p_file')!.label;const step=rows.find(row=>row.title.kind==='text'&&row.title.value===label)!;expect(fact(step,'completed')).toBe(true);
  for(const secret of ['PRIVATE_SUPERVISOR','PRIVATE_COST_CENTRE','PRIVATE_IDENTITY','PRIVATE_CASE_NOTES','PEER-CASE','FOREIGN-CASE',f.peer.email,f.foreign.email])expect(JSON.stringify(view)).not.toContain(secret);
  await revoked(f.admin,f.ctx,'lifecycle');
 });
});
