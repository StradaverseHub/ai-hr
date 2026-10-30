/** Native financial authority and protected Workforce sources remain separate after an entity transfer. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {createCompany,createDepartment} from '../core/admin';
import {hireEmployee} from '../core/org';
import {createMovementEvent} from '../core/movement';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {seedPayrollCycleCatalog,listPayrollCycles} from '../core/payroll-cycle';
import {seedPayComponentCatalog,upsertPayComponent,setEmploymentPayComponent} from '../core/pay-components';
import {createBatch,generatePayslips} from '../core/payroll';
import {setPayrollPermissionGrant} from '../core/payroll-permissions-admin';
import {resolvePayrollPermission} from '../packs/payroll/service';
import {getFormulaEvaluation,savePayFormula,testPayFormula,setPayFormulaActive} from '../core/pay-formula';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import type {PayFormulaContext} from '../lib/pay-formula-model';

const period='2026-05',transferDate='2026-05-11';
const item={code:'SCOPE_FORMULA',name:'Financial scope allowance',label:'Financial scope allowance',kind:'allowance' as const,
 includedInEpf:false,includedInSocsoEis:false,includedInPcb:false,includedInHrdfBase:false,isNonPayable:false,prorates:true};
let base:Base,full:SessionContext,employee:{employmentId:string;personId:string},companyB:string,departmentB:string,cycleId:string,context:PayFormulaContext;

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

async function principal(hrInB=false):Promise<SessionContext>{
 // Real role rows and a matching session snapshot: no forged grants, stale principal or owner bypass.
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'financial-scope-'+randomUUID()}).returning({id:schema.appUser.id});
 const grants=[{role:'hr_admin' as const,companyId:base.companyId},{role:hrInB?'hr_admin' as const:'payroll_partner' as const,companyId:companyB}];
 await owner.db.insert(schema.roleAssignment).values(grants.map(grant=>({tenantId:base.tenantId,appUserId:user.id,...grant})));
 return {tenantId:base.tenantId,userId:user.id,roles:[...new Set(grants.map(grant=>grant.role))],grants,entitlements:full.entitlements};
}

async function assertFinancialBoundary(actor:SessionContext,workforceB:boolean){
 const actual=await withTenant(actor,async tx=>{
  const [scope]=await tx.execute<{fresh:boolean;financialA:boolean;financialB:boolean;workforceA:boolean;workforceB:boolean;employmentWorkforce:boolean}>(sql`select app.principal_snapshot_current() as fresh,app.can_admin_payroll_for(${base.companyId}::uuid) as "financialA",app.can_admin_payroll_for(${companyB}::uuid) as "financialB",app.access_workforce_company(${base.companyId}::uuid,'workforce.view') as "workforceA",app.access_workforce_company(${companyB}::uuid,'workforce.view') as "workforceB",app.access_workforce_employment(${employee.employmentId}::uuid,'workforce.view') as "employmentWorkforce"`);
  const employment=await tx.select({id:schema.employment.id}).from(schema.employment).where(eq(schema.employment.id,employee.employmentId));
  const compensation=await tx.select({basic:schema.compensation.basicSalary}).from(schema.compensation).where(eq(schema.compensation.employmentId,employee.employmentId));
  return {scope,employment,compensation};
 });
 expect(actual.scope).toEqual({fresh:true,financialA:true,financialB:true,workforceA:true,workforceB,employmentWorkforce:workforceB});
 expect(actual.employment).toEqual([{id:employee.employmentId}]);expect(actual.compensation).toHaveLength(1);expect(Number(actual.compensation[0].basic)).toBe(3100);
}

async function outgoingBatch(actor:SessionContext){
 const batch=await createBatch(actor,{companyId:base.companyId,payPeriod:period,payrollCycleId:cycleId});return batch.batchId;
}
async function assertPaid(batchId:string){
 const slips=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId));
 expect(slips).toHaveLength(1);const slip=slips[0];expect(slip.employmentId).toBe(employee.employmentId);
 // Independent expected amounts: outgoing employer owns May 1–10, i.e. 10/31 of 3100 and 310.
 expect(Number(slip.daysWorked)).toBe(10);expect(Number(slip.basicSalary)).toBe(1000);
 const snapshot=slip.statutory as {componentLines:{code:string;amount:number}[]};
 expect(snapshot.componentLines.find(line=>line.code===item.code)?.amount).toBe(100);
 return slip;
}
async function assertAtomicRefusal(actor:SessionContext,batchId:string){
 await expect(generatePayslips(actor,{batchId})).rejects.toMatchObject({code:'FORMULA_SOURCE_DENIED'});
 expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId))).toHaveLength(0);
 expect(await owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.batchId,batchId))).toHaveLength(0);
 const [batch]=await owner.db.select({status:schema.payrollBatch.status}).from(schema.payrollBatch).where(eq(schema.payrollBatch.id,batchId));expect(batch.status).toBe('draft');
}

describe('outgoing payroll preserves financial scope without borrowing protected current-company access',()=>{
 it.each(['fixed','builder'] as const)('%s allowance remains payable with HR A + Payroll Partner B and Workforce A only',async mode=>{
  await configure(mode==='builder'?'Return {#Basic} / 10':undefined);
  const actor=await principal();await assertFinancialBoundary(actor,false);
  const batchId=await outgoingBatch(actor);await generatePayslips(actor,{batchId});await assertPaid(batchId);
  if(mode==='builder'){
   const evidence=await owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.batchId,batchId));
   expect(evidence).toHaveLength(1);expect(evidence[0].readRequirements.categories).toContain('compensation');
   const trace=await getFormulaEvaluation(actor,evidence[0].id);expect(trace).not.toBeNull();expect(Number(trace?.amount)).toBe(100);
   expect(JSON.stringify(trace?.payload)).not.toContain('Fictional transferred payroll employee');
  }
 });

 it('an unread denied Personnel branch cannot block a Basic-only financial calculation',async()=>{
  await configure('If False Then\n {#Explain}({#EmployeeInformation}("nationality"))\n {#Explain}({#EmployeeProfile}("employmentType"))\nEnd If\nReturn {#Basic} / 10');
  const actor=await principal();await assertFinancialBoundary(actor,false);
  const batchId=await outgoingBatch(actor);await generatePayslips(actor,{batchId});await assertPaid(batchId);
  const [evidence]=await owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.batchId,batchId));
  expect(evidence).toBeDefined();expect(evidence.readRequirements.categories).not.toContain('identity');
  expect(JSON.stringify(evidence.payload)).not.toContain('Malaysian');
  expect(await getFormulaEvaluation(actor,evidence.id)).not.toBeNull();
 });

 it.each([
  ['EmployeeInformation','nationality'],['EmployeeProfile','employmentType'],
 ] as const)('an actual %s read still requires current-company Workforce access',async(functionName,field)=>{
  await configure(`{#Explain}({#${functionName}}("${field}"))\nReturn {#Basic} / 10`);
  const actor=await principal();await assertFinancialBoundary(actor,false);
  const batchId=await outgoingBatch(actor);await assertAtomicRefusal(actor,batchId);
  // Same stored inputs and formula work for an independently authorized principal; refusal is not a missing fixture.
  await generatePayslips(full,{batchId});await assertPaid(batchId);
  const [evidence]=await owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.batchId,batchId));
  expect(evidence).toBeDefined();expect(await getFormulaEvaluation(actor,evidence.id)).toBeNull();
 });

 it.each([
  ['EmployeeInformation','nationality','identity'],['EmployeeProfile','employmentType','personnel'],
 ] as const)('intersects current B %s rights instead of borrowing A rights',async(functionName,field,category)=>{
  await configure(`{#Explain}({#${functionName}}("${field}"))\nReturn {#Basic} / 10`);
  const actor=await principal(true);await assertFinancialBoundary(actor,true);
  await setPayrollPermissionGrant(full,{companyId:base.companyId,permissionKey:`report.read.${category}`,role:'hr_admin',allowed:true});
  await setPayrollPermissionGrant(full,{companyId:companyB,permissionKey:`report.read.${category}`,role:'hr_admin',allowed:false});
  const allowed=await withTenant(actor,async tx=>({a:await resolvePayrollPermission(tx,actor,`report.read.${category}`,base.companyId),b:await resolvePayrollPermission(tx,actor,`report.read.${category}`,companyB)}));
  expect(allowed).toEqual({a:true,b:false});
  const batchId=await outgoingBatch(actor);await assertAtomicRefusal(actor,batchId);
  // Granting B restores the same calculation; revoking B hides its retained evidence despite A remaining allowed.
  await setPayrollPermissionGrant(full,{companyId:companyB,permissionKey:`report.read.${category}`,role:'hr_admin',allowed:true});
  await generatePayslips(actor,{batchId});await assertPaid(batchId);
  const [evidence]=await owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.batchId,batchId));
  expect(evidence.readRequirements.categories).toContain(category);expect(await getFormulaEvaluation(actor,evidence.id)).not.toBeNull();
  await setPayrollPermissionGrant(full,{companyId:companyB,permissionKey:`report.read.${category}`,role:'hr_admin',allowed:false});
  expect(await getFormulaEvaluation(actor,evidence.id)).toBeNull();
 });
});
