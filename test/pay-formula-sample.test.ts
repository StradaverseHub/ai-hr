/** Feedback 02472802 round 2 — sample-value test writes nothing; new variables match the legacy owners. */
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {seedPayComponentCatalog,upsertPayComponent,setEmploymentPayComponent} from '../core/pay-components';
import {createBatch,generatePayslips} from '../core/payroll';
import {samplePayFormula,savePayFormula,testPayFormula,setPayFormulaActive} from '../packs/payroll/service';
import {payFormulaTemplateSource} from '../lib/pay-formula-templates';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import type {SessionContext} from '../db/client';
import type {PayFormulaContext} from '../lib/pay-formula-model';

const flags={includedInEpf:false,includedInSocsoEis:false,includedInPcb:false,includedInHrdfBase:false,isNonPayable:false,prorates:false};
const item={code:'FB_FIXED',name:'Formula fixed allowance reader',label:'Formula fixed allowance reader',kind:'allowance' as const,...flags};
let base:Base,ctx:SessionContext,employee:{employmentId:string;personId:string},context:PayFormulaContext;
const tables=['pay_formula','pay_formula_revision','pay_formula_test','pay_formula_event','pay_formula_evaluation','domain_event','payroll_batch','payslip'] as const;
async function counts(){const out:Record<string,number>={};for(const table of tables){const [row]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from ${sql.identifier(table)}`);out[table]=row.n;}return out;}

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();base=await seedBase();await setModule(base.tenantId,'typed_pay_components','active');ctx=await entitledCtx(base);
 employee=await hireEmployee(ctx,{person:{fullName:'Fictional sample employee',primaryEmail:'formula-sample@example.invalid'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
 await setCompensation(ctx,{employmentId:employee.employmentId,basicSalary:3500,monthlyAllowance:0,effectiveFrom:'2026-01-01'});
 await setStatutoryProfileMY(ctx,{personId:employee.personId,icNumber:'900101011234'});await seedPayComponentCatalog(ctx);
 const housing=await upsertPayComponent(ctx,{code:'FX_HOUSING',name:'Fictional housing',label:'Fictional housing',kind:'allowance',...flags,orpOvertime:true,rule:null});
 const meal=await upsertPayComponent(ctx,{code:'FX_MEAL',name:'Fictional meal',label:'Fictional meal',kind:'allowance',...flags,orpOvertime:false,rule:null});
 for(const [component,amount] of [[housing,300],[meal,999]] as const)await setEmploymentPayComponent(ctx,{employmentId:employee.employmentId,componentId:component.id,amount,effectiveFrom:'2026-05-01'});
 await upsertPayComponent(ctx,{...item,rule:{kind:'fixed'}});
 const [cycle]=await owner.db.insert(schema.payrollCycle).values({tenantId:base.tenantId,companyId:base.companyId,name:'Sample cycle',code:'FORMULA_SAMPLE',runType:'regular'}).returning();
 context={companyId:base.companyId,employmentId:employee.employmentId,cycleId:cycle.id,period:'2026-05',asOf:'2026-05-31',currentCode:item.code,input:'10'};
});

describe('sample-value test',()=>{
 it('evaluates unsaved source with typed values and writes no formula, test, event or payroll rows',async()=>{
  await savePayFormula(ctx,{formulaId:'EXISTING',description:'Existing fictional formula',method:'write',source:'Return 1'});
  const before=await counts();
  const result=await samplePayFormula(ctx,{source:payFormulaTemplateSource('OT_1_5','Hourly rate: '),values:{Basic:'3500',FixedAllowances:'300',CalendarDays:'31',Input:'10'}});
  expect(result).toMatchObject({passed:true,payable:'274.04',error:null});
  const unsupported=await samplePayFormula(ctx,{source:'Return {#PayItem}("FX_HOUSING")',values:{}});
  expect(unsupported.error).toMatchObject({code:'needs_employee_test',variable:'PayItem'});
  expect(await counts()).toEqual(before);expect(before.pay_formula).toBe(1);
 });
 it('requires formula catalogue access and still writes nothing when refused',async()=>{
  const before=await counts();const employeeOnly=await entitledCtx(base,['employee']);
  await expect(samplePayFormula(employeeOnly,{source:'Return 1',values:{}})).rejects.toThrow('Formula access is unavailable');
  expect(await counts()).toEqual(before);
 });
 it('never counts as activation evidence',async()=>{
  const saved=await savePayFormula(ctx,{formulaId:'SAMPLED',description:'Sampled only',method:'write',source:'Return {#Basic} / {#CalendarDays} * {#Input}'});
  await samplePayFormula(ctx,{source:'Return {#Basic} / {#CalendarDays} * {#Input}',values:{Basic:'3100',CalendarDays:'31',Input:'2'}});
  await expect(setPayFormulaActive(ctx,{...saved,active:true})).rejects.toThrow(/Test/);
 });
});

describe('CalendarDays and FixedAllowances in the employee test and the payroll run',()=>{
 it('reads the period length and the same fixed-allowance members as the legacy fixed_allowances operand',async()=>{
  const source='Return {#FixedAllowances} + {#CalendarDays}';
  const saved=await savePayFormula(ctx,{formulaId:'FIXED_READER',description:'Fictional fixed allowance reader',method:'write',source});
  const test=await testPayFormula(ctx,{...saved,context});expect(test.passed,test.error??'passing test').toBe(true);
  // FX_HOUSING (300) is ticked for the overtime rate; FX_MEAL (999) is not. May has 31 days.
  expect(test.amount).toBe('331');
  await setPayFormulaActive(ctx,{...saved,testId:test.id,active:true});
  const reader=await upsertPayComponent(ctx,{...item,rule:{kind:'formula_builder',formulaId:'FIXED_READER',dependencies:[]}});
  await setEmploymentPayComponent(ctx,{employmentId:employee.employmentId,componentId:reader.id,amount:10,effectiveFrom:'2026-05-01',allowZeroAmount:true});
  const legacy=await upsertPayComponent(ctx,{code:'FX_LEGACY',name:'Fictional legacy reader',label:'Fictional legacy reader',kind:'allowance',...flags,rule:{kind:'formula',start:{ref:'fixed_allowances'},terms:[{op:'*',operand:{ref:'number',value:1}}]}});
  await setEmploymentPayComponent(ctx,{employmentId:employee.employmentId,componentId:legacy.id,amount:0,effectiveFrom:'2026-05-01',allowZeroAmount:true});
  const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:context.period,payrollCycleId:context.cycleId});await generatePayslips(ctx,{batchId});
  const [slip]=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId));
  const lines=(slip.statutory as {componentLines:{code:string;amount:number}[]}).componentLines;
  const legacyAmount=lines.find(l=>l.code==='FX_LEGACY')?.amount;
  expect(legacyAmount).toBe(300);expect(lines.find(l=>l.code===item.code)?.amount).toBe(legacyAmount!+31);
 });
 it('a change to fixed-allowance membership invalidates the saved test snapshot for a reader',async()=>{
  const saved=await savePayFormula(ctx,{formulaId:'FIXED_SNAPSHOT',description:'Fictional snapshot reader',method:'write',source:'Return {#FixedAllowances}'});
  await upsertPayComponent(ctx,{code:'FX_MEAL',name:'Fictional meal',label:'Fictional meal',kind:'allowance',...flags,orpOvertime:true,rule:null});
  await expect(testPayFormula(ctx,{...saved,context})).rejects.toThrow(/Dependencies changed/);
 });
 it('refuses to save a plain zero divisor but keeps a possibly-zero input as a warning only',async()=>{
  await expect(savePayFormula(ctx,{formulaId:'ZERO',description:'Plain zero',method:'write',source:'Return {#Basic} / 0'})).rejects.toThrow(/Division by zero/);
  await expect(savePayFormula(ctx,{formulaId:'INPUT_DIV',description:'Input divisor',method:'write',source:'Return {#Basic} / {#Input}'})).resolves.toMatchObject({id:expect.any(String)});
 });
});
