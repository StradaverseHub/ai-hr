import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {seedPayComponentCatalog,upsertPayComponent,setEmploymentPayComponent} from '../core/pay-components';
import {createBatch,generatePayslips} from '../core/payroll';
import {savePayFormula,testPayFormula,setPayFormulaActive,getFormulaEvaluation} from '../core/pay-formula';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import type {SessionContext} from '../db/client';
import type {PayFormulaContext} from '../lib/pay-formula-model';
let base:Base,ctx:SessionContext,employee:{employmentId:string;personId:string},context:PayFormulaContext;
const item={code:'EXACT_FORMULA',name:'Exact formula allowance',label:'Exact formula allowance',kind:'allowance' as const,includedInEpf:false,includedInSocsoEis:false,includedInPcb:false,includedInHrdfBase:false,isNonPayable:false,prorates:false,formulaContext:{rate:'1.005'}};
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();base=await seedBase();await setModule(base.tenantId,'typed_pay_components','active');ctx=await entitledCtx(base);
 employee=await hireEmployee(ctx,{person:{fullName:'Fictional runtime employee',primaryEmail:'formula-runtime@example.invalid'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
 await setCompensation(ctx,{employmentId:employee.employmentId,basicSalary:5000,monthlyAllowance:0,effectiveFrom:'2026-01-01'});
 await setStatutoryProfileMY(ctx,{personId:employee.personId,icNumber:'900101011234'});await seedPayComponentCatalog(ctx);await upsertPayComponent(ctx,{...item,rule:{kind:'fixed'}});
 const [cycle]=await owner.db.insert(schema.payrollCycle).values({tenantId:base.tenantId,companyId:base.companyId,name:'Formula runtime cycle',code:'FORMULA_RUNTIME',runType:'regular'}).returning();
 context={companyId:base.companyId,employmentId:employee.employmentId,cycleId:cycle.id,period:'2026-05',asOf:'2026-05-31',currentCode:item.code,input:'3'};
});
async function activate(source:string,input='3'){
 const saved=await savePayFormula(ctx,{formulaId:'RUNTIME',description:'Fictional native integration',method:'write',source}),test=await testPayFormula(ctx,{...saved,context:{...context,input}});
 expect(test.passed,test.error??'successful test').toBe(true);await setPayFormulaActive(ctx,{...saved,testId:test.id,active:true});
 const component=await upsertPayComponent(ctx,{...item,rule:{kind:'formula_builder',formulaId:'RUNTIME',dependencies:[]}});
 await setEmploymentPayComponent(ctx,{employmentId:employee.employmentId,componentId:component.id,amount:Number(context.input),effectiveFrom:context.period+'-01',allowZeroAmount:true});return test;
}
it('uses the same exact input and rate evaluator for simulation and a native payslip, with private evidence references',async()=>{
 const simulated=await activate('Return {#Basic} / 10 + {#Input} * {#Rate}');expect(simulated.amount).toBe('503.02');
 const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:context.period,payrollCycleId:context.cycleId});await generatePayslips(ctx,{batchId});
 const [slip]=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId));
 const snapshot=slip.statutory as {componentLines:{code:string;amount:number}[];formulaEvaluations:Record<string,unknown>[]};
 expect(snapshot.componentLines.find(l=>l.code===item.code)?.amount).toBe(503.02);expect(snapshot.formulaEvaluations).toHaveLength(1);
 expect(snapshot.formulaEvaluations[0]).toMatchObject({formulaId:'RUNTIME',amount:'503.02'});
 expect(snapshot.formulaEvaluations[0]).not.toHaveProperty('reads');expect(snapshot.formulaEvaluations[0]).not.toHaveProperty('explanations');
 const evidence=await owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.batchId,batchId));expect(evidence).toHaveLength(1);
});
it('blocks payroll atomically when valid test input becomes a zero runtime divisor',async()=>{
 context.input='0';await activate('Return 100 / {#Input}','1');
 const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:context.period,payrollCycleId:context.cycleId});await expect(generatePayslips(ctx,{batchId})).rejects.toThrow();
 expect(await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId))).toHaveLength(0);
 expect(await owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.batchId,batchId))).toHaveLength(0);
 const [batch]=await owner.db.select().from(schema.payrollBatch).where(eq(schema.payrollBatch.id,batchId));expect(batch.status).toBe('draft');
});
it('keeps prefetched but unread branch values out of retained evidence',async()=>{
 const secret='private-unused-nationality';await owner.db.update(schema.person).set({nationality:secret}).where(eq(schema.person.id,employee.personId));
 await activate('If False Then\n Explain {#EmployeeInformation}("nationality")\nEnd If\nReturn 1');
 const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:context.period,payrollCycleId:context.cycleId});await generatePayslips(ctx,{batchId});
 const [evidence]=await owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.batchId,batchId));
 expect(JSON.stringify(evidence.payload)).not.toContain(secret);expect(evidence.readRequirements.categories).not.toContain('identity');
});
it('keeps actual private reads out of payslips and revokes access to their retained trace',async()=>{
 const secret='private-used-nationality';await owner.db.update(schema.person).set({nationality:secret}).where(eq(schema.person.id,employee.personId));
 await activate('Explain {#EmployeeInformation}("nationality")\nReturn 1');
 const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:context.period,payrollCycleId:context.cycleId});await generatePayslips(ctx,{batchId});
 const [evidence]=await owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.batchId,batchId));
 expect(evidence.readRequirements.categories).toContain('identity');expect(JSON.stringify(evidence.payload)).toContain(secret);
 const [slip]=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId));expect(JSON.stringify(slip.statutory)).not.toContain(secret);
 expect(await getFormulaEvaluation(ctx,evidence.id)).not.toBeNull();
 await owner.db.insert(schema.payrollPermissionGrant).values(['hr_admin','super_admin'].map(role=>({tenantId:base.tenantId,companyId:base.companyId,role,permissionKey:'report.read.identity',allowed:false})));
 expect(await getFormulaEvaluation(ctx,evidence.id)).toBeNull();
});
