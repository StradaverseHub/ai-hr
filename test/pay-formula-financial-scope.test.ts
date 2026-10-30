/** Native financial authority and protected Workforce sources remain separate after an entity transfer. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {createCompany,createDepartment} from '../core/admin';
import {hireEmployee} from '../core/org';
import {createMovementEvent} from '../core/movement';
import {setCompensation,compensationEffectiveOn} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {seedPayrollCycleCatalog,listPayrollCycles} from '../core/payroll-cycle';
import {seedPayComponentCatalog,upsertPayComponent,setEmploymentPayComponent} from '../core/pay-components';
import {createBatch,generatePayslips} from '../core/payroll';
import {setPayrollPermissionGrant} from '../core/payroll-permissions-admin';
import {employedByCompanyDuring} from '../core/employment-company';
import {resolvePayrollPermission,readPayrollComponentInputsTx} from '../packs/payroll/service';
import {getFormulaEvaluation,savePayFormula,testPayFormula,setPayFormulaActive} from '../core/pay-formula';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import type {PayFormulaContext} from '../lib/pay-formula-model';

const period='2026-05',transferDate='2026-05-11';
const item={code:'SCOPE_FORMULA',name:'Financial scope allowance',label:'Financial scope allowance',kind:'allowance' as const,
 includedInEpf:false,includedInSocsoEis:false,includedInPcb:false,includedInHrdfBase:false,isNonPayable:false,prorates:true};
let base:Base,full:SessionContext,employee:{employmentId:string;personId:string},companyB:string,departmentB:string,cycleId:string,cycleB:string,context:PayFormulaContext;

beforeAll(migrateTestDb);
afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();base=await seedBase();await setModule(base.tenantId,'typed_pay_components','active');
 full={...await entitledCtx(base),grants:[{role:'hr_admin',companyId:null}]};
 const company=await createCompany(full,{legalName:'Fictional incoming employer',country:'MY'});companyB=company.id;
 departmentB=(await createDepartment(full,{companyId:companyB,name:'Incoming team'})).id;
 employee=await hireEmployee(full,{person:{fullName:'Fictional transferred payroll employee',primaryEmail:'financial-scope@example.invalid',nationality:'Malaysian'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
 await setCompensation(full,{employmentId:employee.employmentId,basicSalary:3100,monthlyAllowance:0,effectiveFrom:'2026-01-01'});
 await setStatutoryProfileMY(full,{personId:employee.personId,icNumber:'900101011234'});
 await seedPayrollCycleCatalog(full,base.companyId);
 const cycles=(await listPayrollCycles(full,base.companyId,{activeOnly:true})).filter(cycle=>cycle.runType==='regular');
 expect(cycles).toHaveLength(1);cycleId=cycles[0].id;
 const incomingCycles=(await listPayrollCycles(full,companyB,{activeOnly:true})).filter(cycle=>cycle.runType==='regular');expect(incomingCycles).toHaveLength(1);cycleB=incomingCycles[0].id;
 await seedPayComponentCatalog(full);await upsertPayComponent(full,{...item,rule:{kind:'fixed'}});
 context={companyId:base.companyId,employmentId:employee.employmentId,cycleId,period,asOf:'2026-05-10',currentCode:item.code,input:'310'};
});

async function configure(source?:string){
 if(source){
  // The saved receipt and activation happen under the full HR principal BEFORE any transfer or restriction.
  const saved=await savePayFormula(full,{formulaId:'FINANCIAL_SCOPE',description:'Outgoing employer source-authority regression',method:'write',source});
  const receipt=await testPayFormula(full,{...saved,context});expect(receipt.passed,receipt.error??'successful activation test').toBe(true);
  await setPayFormulaActive(full,{...saved,testId:receipt.id,active:true});
  await upsertPayComponent(full,{...item,rule:{kind:'formula_builder',formulaId:'FINANCIAL_SCOPE',dependencies:[]}});
 }
 const [component]=await owner.db.select({id:schema.payComponent.id}).from(schema.payComponent).where(eq(schema.payComponent.code,item.code));
 expect(component).toBeDefined();
 await setEmploymentPayComponent(full,{employmentId:employee.employmentId,componentId:component.id,amount:310,effectiveFrom:period+'-01'});
 await createMovementEvent(full,{employmentId:employee.employmentId,kind:'entityTransfer',effectiveDate:transferDate,companyId:companyB,departmentId:departmentB});
 const [current]=await owner.db.select({companyId:schema.employment.companyId}).from(schema.employment).where(eq(schema.employment.id,employee.employmentId));
 expect(current.companyId).toBe(companyB);
}

type PrincipalMode='unrelatedHybrid'|'financialSelf'|'bothHr';
async function principal(mode:PrincipalMode):Promise<SessionContext>{
 // Self-read is an EXISTING Native prerequisite for recurring inputs when the actor has no HR role.
 // It does not confer Workforce purpose: a payroll-partner-only principal still fails that HR ceiling.
 const personId=mode==='financialSelf'?employee.personId:null;
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,personId,workosUserId:'financial-scope-'+randomUUID()}).returning({id:schema.appUser.id});
 const grants=mode==='financialSelf'?[{role:'payroll_partner' as const,companyId:companyB}]:[
  {role:'hr_admin' as const,companyId:base.companyId},{role:mode==='bothHr'?'hr_admin' as const:'payroll_partner' as const,companyId:companyB},
 ];
 await owner.db.insert(schema.roleAssignment).values(grants.map(grant=>({tenantId:base.tenantId,appUserId:user.id,...grant})));
 if(mode==='financialSelf')for(const category of ['compensation','personnel'])for(const role of ['payroll_partner','hr_admin']){
  await setPayrollPermissionGrant(full,{companyId:companyB,permissionKey:`report.read.${category}`,role,allowed:true});
 }
 return {tenantId:base.tenantId,userId:user.id,personId,roles:[...new Set(grants.map(grant=>grant.role))],grants,entitlements:full.entitlements};
}

async function assertFinancialBoundary(actor:SessionContext,mode:PrincipalMode){
 const actual=await withTenant(actor,async tx=>{
  const [scope]=await tx.execute<{fresh:boolean;financialA:boolean;financialB:boolean;workforceA:boolean;workforceB:boolean;employmentWorkforce:boolean}>(sql`select app.principal_snapshot_current() as fresh,app.can_admin_payroll_for(${base.companyId}::uuid) as "financialA",app.can_admin_payroll_for(${companyB}::uuid) as "financialB",app.access_workforce_company(${base.companyId}::uuid,'workforce.view') as "workforceA",app.access_workforce_company(${companyB}::uuid,'workforce.view') as "workforceB",app.access_workforce_employment(${employee.employmentId}::uuid,'workforce.view') as "employmentWorkforce"`);
  const employment=await tx.select({id:schema.employment.id}).from(schema.employment).where(eq(schema.employment.id,employee.employmentId));
  const compensation=await tx.select({basic:schema.compensation.basicSalary}).from(schema.compensation).where(eq(schema.compensation.employmentId,employee.employmentId));
  return {scope,employment,compensation};
 });
 const financialOnly=mode==='financialSelf',workforceB=mode==='bothHr';
 expect(actual.scope).toEqual({fresh:true,financialA:!financialOnly,financialB:true,workforceA:!financialOnly,workforceB,employmentWorkforce:workforceB});
 expect(actual.employment).toEqual([{id:employee.employmentId}]);expect(actual.compensation).toHaveLength(1);expect(Number(actual.compensation[0].basic)).toBe(3100);
}

/** Query the actual Native eligibility join and canonical input reader, not merely the visible header. */
async function assertNativeSelection(actor:SessionContext,payingCompany:string,expected:number){
 const selected=await withTenant(actor,async tx=>{
  const employees=await tx.select({id:schema.employment.id}).from(schema.employment)
   .innerJoin(schema.person,eq(schema.person.id,schema.employment.personId))
   .innerJoin(schema.compensation,and(eq(schema.compensation.employmentId,schema.employment.id),compensationEffectiveOn(period+'-31')))
   .where(and(eq(schema.employment.id,employee.employmentId),employedByCompanyDuring(payingCompany,period+'-01',period+'-31')));
  const assignments=await tx.select({id:schema.assignment.id}).from(schema.assignment).where(eq(schema.assignment.employmentId,employee.employmentId));
  const inputs=await readPayrollComponentInputsTx(tx,{employmentIds:[employee.employmentId],periodStart:period+'-01',periodEnd:period+'-31'});
  return {employees,assignments,recurring:inputs.recurring.filter(row=>row.code===item.code)};
 });
 expect(selected.employees).toHaveLength(expected);expect(selected.recurring).toHaveLength(expected);
 if(expected){expect(selected.employees).toEqual([{id:employee.employmentId}]);expect(selected.assignments.length).toBeGreaterThan(0);expect(Number(selected.recurring[0].amount)).toBe(310);}
 else expect(selected.assignments).toHaveLength(0);
}

async function payrollBatchFor(actor:SessionContext,incoming=false){
 const batch=await createBatch(actor,{companyId:incoming?companyB:base.companyId,payPeriod:period,payrollCycleId:incoming?cycleB:cycleId});return batch.batchId;
}
async function assertPaid(batchId:string,incoming=false){
 const slips=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId));
 expect(slips).toHaveLength(1);const slip=slips[0];expect(slip.employmentId).toBe(employee.employmentId);
 // Independent expected amounts: A owns 10/31; current employer B owns 21/31 of 3100 and 310.
 expect(Number(slip.daysWorked)).toBe(incoming?21:10);expect(Number(slip.basicSalary)).toBe(incoming?2100:1000);
 const snapshot=slip.statutory as {componentLines:{code:string;amount:number}[]};
 expect(snapshot.componentLines.find(line=>line.code===item.code)?.amount).toBe(incoming?210:100);
 return slip;
}
async function assertAtomicRefusal(actor:SessionContext,batchId:string){
 await expect(generatePayslips(actor,{batchId})).rejects.toMatchObject({code:'FORMULA_SOURCE_DENIED'});
 expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId))).toHaveLength(0);
 expect(await owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.batchId,batchId))).toHaveLength(0);
 const [batch]=await owner.db.select({status:schema.payrollBatch.status}).from(schema.payrollBatch).where(eq(schema.payrollBatch.id,batchId));expect(batch.status).toBe('draft');
}

describe('Native financial authority is independent of protected Workforce-purpose reads',()=>{
 it('records the existing unrelated outgoing actor RLS limit instead of mistaking an empty run for a builder regression',async()=>{
  await configure();const actor=await principal('unrelatedHybrid');await assertFinancialBoundary(actor,'unrelatedHybrid');
  const history=await owner.db.select().from(schema.assignment).where(eq(schema.assignment.employmentId,employee.employmentId));expect(history.length).toBeGreaterThan(1);
  await assertNativeSelection(actor,base.companyId,0);const batchId=await payrollBatchFor(actor);
  const result=await generatePayslips(actor,{batchId});expect(result.payslips).toBe(0);
  expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId))).toHaveLength(0);
 });
 it.each(['fixed','builder'] as const)('%s current-company allowance remains payable with Payroll Partner only and no Workforce purpose',async mode=>{
  await configure(mode==='builder'?'Return {#Basic} / 10':undefined);
  const actor=await principal('financialSelf');await assertFinancialBoundary(actor,'financialSelf');await assertNativeSelection(actor,companyB,1);
  const batchId=await payrollBatchFor(actor,true);await generatePayslips(actor,{batchId});await assertPaid(batchId,true);
  if(mode==='builder'){
   const evidence=await owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.batchId,batchId));
   expect(evidence).toHaveLength(1);expect(evidence[0].readRequirements.categories).toContain('compensation');
   const trace=await getFormulaEvaluation(actor,evidence[0].id);expect(trace).not.toBeNull();expect(Number(trace?.amount)).toBe(210);
   expect(JSON.stringify(trace?.payload)).not.toContain('Fictional transferred payroll employee');
  }
 });

 it('an unread denied Personnel branch cannot block a Basic-only financial calculation',async()=>{
  await configure('If False Then\n {#Explain}({#EmployeeInformation}("nationality"))\n {#Explain}({#EmployeeProfile}("employmentType"))\nEnd If\nReturn {#Basic} / 10');
  const actor=await principal('financialSelf');await assertFinancialBoundary(actor,'financialSelf');await assertNativeSelection(actor,companyB,1);
  const batchId=await payrollBatchFor(actor,true);await generatePayslips(actor,{batchId});await assertPaid(batchId,true);
  const [evidence]=await owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.batchId,batchId));
  expect(evidence).toBeDefined();expect(evidence.readRequirements.categories).not.toContain('identity');
  expect(JSON.stringify(evidence.payload)).not.toContain('Malaysian');
  expect(await getFormulaEvaluation(actor,evidence.id)).not.toBeNull();
 });

 it.each([
  ['EmployeeInformation','nationality'],['EmployeeProfile','employmentType'],
 ] as const)('an actual %s read still requires current-company Workforce access',async(functionName,field)=>{
  await configure(`{#Explain}({#${functionName}}("${field}"))\nReturn {#Basic} / 10`);
  const actor=await principal('financialSelf');await assertFinancialBoundary(actor,'financialSelf');await assertNativeSelection(actor,companyB,1);
  const batchId=await payrollBatchFor(actor,true);await assertAtomicRefusal(actor,batchId);
  // Same stored inputs and formula work for an independently authorized principal; refusal is not a missing fixture.
  await generatePayslips(full,{batchId});await assertPaid(batchId,true);
  const [evidence]=await owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.batchId,batchId));
  expect(evidence).toBeDefined();expect(await getFormulaEvaluation(actor,evidence.id)).toBeNull();
 });

 it.each([
  ['EmployeeInformation','nationality','identity'],['EmployeeProfile','employmentType','personnel'],
 ] as const)('intersects current B %s rights instead of borrowing A rights',async(functionName,field,category)=>{
  await configure(`{#Explain}({#${functionName}}("${field}"))\nReturn {#Basic} / 10`);
  const actor=await principal('bothHr');await assertFinancialBoundary(actor,'bothHr');await assertNativeSelection(actor,base.companyId,1);
  await setPayrollPermissionGrant(full,{companyId:base.companyId,permissionKey:`report.read.${category}`,role:'hr_admin',allowed:true});
  await setPayrollPermissionGrant(full,{companyId:companyB,permissionKey:`report.read.${category}`,role:'hr_admin',allowed:false});
  const allowed=await withTenant(actor,async tx=>({a:await resolvePayrollPermission(tx,actor,`report.read.${category}`,base.companyId),b:await resolvePayrollPermission(tx,actor,`report.read.${category}`,companyB)}));
  expect(allowed).toEqual({a:true,b:false});
  const batchId=await payrollBatchFor(actor);await assertAtomicRefusal(actor,batchId);
  // Granting B restores the same calculation; revoking B hides its retained evidence despite A remaining allowed.
  await setPayrollPermissionGrant(full,{companyId:companyB,permissionKey:`report.read.${category}`,role:'hr_admin',allowed:true});
  await generatePayslips(actor,{batchId});await assertPaid(batchId);
  const [evidence]=await owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.batchId,batchId));
  expect(evidence.readRequirements.categories).toContain(category);expect(await getFormulaEvaluation(actor,evidence.id)).not.toBeNull();
  await setPayrollPermissionGrant(full,{companyId:companyB,permissionKey:`report.read.${category}`,role:'hr_admin',allowed:false});
  expect(await getFormulaEvaluation(actor,evidence.id)).toBeNull();
 });
});
