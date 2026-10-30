import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {seedPayComponentCatalog,upsertPayComponent,setEmploymentPayComponent} from '../core/pay-components';
import {createBatch,generatePayslips} from '../core/payroll';
import {savePayFormula,testPayFormula,setPayFormulaActive,getFormulaEvaluation,saveFormulaAccumulationGroup} from '../core/pay-formula';
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
async function activate(source:string,input='3',overrides:{prorates?:boolean;formulaContext?:{ordinaryRate?:string;hoursPerDay?:string;rate?:string}}={}){
 const saved=await savePayFormula(ctx,{formulaId:'RUNTIME',description:'Fictional native integration',method:'write',source}),test=await testPayFormula(ctx,{...saved,context:{...context,input}});
 expect(test.passed,test.error??'successful test').toBe(true);await setPayFormulaActive(ctx,{...saved,testId:test.id,active:true});
 const component=await upsertPayComponent(ctx,{...item,...overrides,rule:{kind:'formula_builder',formulaId:'RUNTIME',dependencies:[]}});
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
 await activate('If False Then\n {#Explain}({#EmployeeInformation}("nationality"))\nEnd If\nReturn 1');
 const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:context.period,payrollCycleId:context.cycleId});await generatePayslips(ctx,{batchId});
 const [evidence]=await owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.batchId,batchId));
 expect(JSON.stringify(evidence.payload)).not.toContain(secret);expect(evidence.readRequirements.categories).not.toContain('identity');
});
it('keeps actual private reads out of payslips and revokes access to their retained trace',async()=>{
 const secret='private-used-nationality';await owner.db.update(schema.person).set({nationality:secret}).where(eq(schema.person.id,employee.personId));
 await activate('{#Explain}({#EmployeeInformation}("nationality"))\nReturn 1');
 const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:context.period,payrollCycleId:context.cycleId});await generatePayslips(ctx,{batchId});
 const [evidence]=await owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.batchId,batchId));
 expect(evidence.readRequirements.categories).toContain('identity');expect(JSON.stringify(evidence.payload)).toContain(secret);
 const [slip]=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId));expect(JSON.stringify(slip.statutory)).not.toContain(secret);
 expect(await getFormulaEvaluation(ctx,evidence.id)).not.toBeNull();
 await owner.db.insert(schema.payrollPermissionGrant).values(['hr_admin','super_admin'].map(role=>({tenantId:base.tenantId,companyId:base.companyId,role,permissionKey:'report.read.identity',allowed:false})));
 expect(await getFormulaEvaluation(ctx,evidence.id)).toBeNull();
});
it('rejects a current-company effective date as authority for another payroll month',async()=>{
 const saved=await savePayFormula(ctx,{formulaId:'DATES',description:'Date scope',method:'write',source:'Return {#PayItemInput}("EXACT_FORMULA")'});
 await expect(testPayFormula(ctx,{...saved,context:{...context,period:'2026-04'}})).rejects.toThrow(/effective date within/);
 expect(await owner.db.select().from(schema.payFormulaTest)).toHaveLength(0);
});
it('does not retain a failed receipt for denied private source access',async()=>{
 const saved=await savePayFormula(ctx,{formulaId:'PRIVATE',description:'Private source',method:'write',source:'{#Explain}({#EmployeeInformation}("nationality"))\nReturn 1'});
 await owner.db.insert(schema.payrollPermissionGrant).values(['hr_admin','super_admin'].map(role=>({tenantId:base.tenantId,companyId:base.companyId,role,permissionKey:'report.read.identity',allowed:false})));
 await expect(testPayFormula(ctx,{...saved,context})).rejects.toThrow(/permission is unavailable/);
 expect(await owner.db.select().from(schema.payFormulaTest)).toHaveLength(0);
});
it('protects the implicit personnel and compensation sources of a constant prorated result',async()=>{
 await upsertPayComponent(ctx,{...item,prorates:true,rule:{kind:'fixed'}});await activate('Return 100','3',{prorates:true});
 const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:context.period,payrollCycleId:context.cycleId});await generatePayslips(ctx,{batchId});
 const [evidence]=await owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.batchId,batchId));
 expect(evidence.readRequirements.categories).toEqual(expect.arrayContaining(['personnel','compensation']));
 await owner.db.insert(schema.payrollPermissionGrant).values(['hr_admin','super_admin'].map(role=>({tenantId:base.tenantId,companyId:base.companyId,role,permissionKey:'report.read.personnel',allowed:false})));
 expect(await getFormulaEvaluation(ctx,evidence.id)).toBeNull();
});
it('keeps saved named inputs separate from the sample current input, including two source instances',async()=>{
 const [component]=await owner.db.select().from(schema.payComponent).where(eq(schema.payComponent.code,item.code));
 await setEmploymentPayComponent(ctx,{employmentId:employee.employmentId,componentId:component.id,amount:5,effectiveFrom:context.period+'-01'});
 const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:context.period,payrollCycleId:context.cycleId});
 await owner.db.insert(schema.payrollBatchComponent).values({tenantId:base.tenantId,batchId,employmentId:employee.employmentId,componentId:component.id,amount:'7'});
 const saved=await savePayFormula(ctx,{formulaId:'RAW',description:'Original sources',method:'write',source:'Return {#Input} + {#PayItemInput}("EXACT_FORMULA")'});
 const result=await testPayFormula(ctx,{...saved,context:{...context,batchId} as PayFormulaContext});expect(result.amount).toBe('15');
});
it('reads typed dates and legacy nullable-company assignment fields through their canonical owners',async()=>{
 await owner.db.update(schema.person).set({dateOfBirth:'1990-01-01'}).where(eq(schema.person.id,employee.personId));
 await owner.db.update(schema.assignment).set({companyId:null}).where(eq(schema.assignment.employmentId,employee.employmentId));
 const [grade]=await owner.db.insert(schema.jobGrade).values({tenantId:base.tenantId,code:'G7',name:'A different display label'}).returning();await owner.db.update(schema.employment).set({gradeId:grade.id}).where(eq(schema.employment.id,employee.employmentId));
 const saved=await savePayFormula(ctx,{formulaId:'PROFILE',description:'Typed native fields',method:'write',source:'If {#EmployeeInformation}("dateOfBirth") = {#Date}("1990-01-01") And {#EmployeeProfile}("employmentType") = "full_time" And {#EmployeeProfile}("gradeCode") = "G7" Then\n Return 1\nElse\n Return 0\nEnd If'});
 const result=await testPayFormula(ctx,{...saved,context});expect(result.passed,result.error??'typed sources').toBe(true);expect(result.amount).toBe('1');
});
it('matches the approved Monthly overtime vocabulary and explicit rate bindings in a real payroll result',async()=>{
 const allowance=await upsertPayComponent(ctx,{...item,code:'OT_BASE_ALLOWANCE',name:'OT base allowance',rule:{kind:'fixed'}});
 await setEmploymentPayComponent(ctx,{employmentId:employee.employmentId,componentId:allowance.id,amount:500,effectiveFrom:context.period+'-01'});
 await saveFormulaAccumulationGroup(ctx,{code:'OT_GROSS',members:['OT_BASE_ALLOWANCE']});
 const formulaContext={ordinaryRate:'26',hoursPerDay:'8',rate:'1.5'};await upsertPayComponent(ctx,{...item,formulaContext,rule:{kind:'fixed'}});
 const source='Dim Gross As Decimal = {#Basic} + {#Accumulation}("OT_GROSS")\nIf Gross > 4000 Then\n Gross = 4000\nEnd If\nIf {#Payrate} = "Monthly" Then\n Return Gross / {#OrdinaryRate} / {#HoursPerDay} * {#Rate} * {#Input}\nElse\n Return 0\nEnd If';
 const result=await activate(source,'3',{formulaContext});expect(result.amount).toBe('86.54');
 const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:context.period,payrollCycleId:context.cycleId});await generatePayslips(ctx,{batchId});
 const [slip]=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId));const lines=(slip.statutory as {componentLines:{code:string;amount:number}[]}).componentLines;
 expect(lines.find(l=>l.code===item.code)?.amount).toBe(86.54);
});
it('preserves legacy prorated_basic semantics when a builder depends on a daily employee legacy item',async()=>{
 await setCompensation(ctx,{employmentId:employee.employmentId,basicSalary:5000,monthlyAllowance:0,effectiveFrom:'2026-01-01',payMode:'daily',rateAmount:100});
 const legacy=await upsertPayComponent(ctx,{...item,code:'LEGACY_SCOPE',name:'Legacy scope',rule:{kind:'formula',start:{ref:'prorated_basic'},terms:[]}});
 await setEmploymentPayComponent(ctx,{employmentId:employee.employmentId,componentId:legacy.id,amount:1,effectiveFrom:context.period+'-01'});
 const result=await activate('Return {#PayItem}("LEGACY_SCOPE")');expect(result.amount).toBe('5000');
 const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:context.period,payrollCycleId:context.cycleId});await generatePayslips(ctx,{batchId});
 const [slip]=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId));expect((slip.statutory as {componentLines:{code:string;amount:number}[]}).componentLines.find(l=>l.code===item.code)?.amount).toBe(5000);
});
it('reads an exact retained historical contribution instead of a current value or zero fallback',async()=>{
 await activate('Return 123.45');const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:context.period,payrollCycleId:context.cycleId});await generatePayslips(ctx,{batchId});
 const [slip]=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId));
 const [run]=await owner.db.select({runSeq:schema.payrollBatch.runSeq}).from(schema.payrollBatch).where(eq(schema.payrollBatch.id,batchId));
 const saved=await savePayFormula(ctx,{formulaId:'HISTORY',description:'Exact source result',method:'write',source:`Return {#AnotherPayItems}("${item.code}", "${context.period}", "${context.cycleId}", "${run.runSeq}")`});
 const result=await testPayFormula(ctx,{...saved,context:{...context,period:'2026-06',asOf:'2026-06-30'}});expect(result.passed,result.error??'retained source').toBe(true);expect(result.amount).toBe('123.45');
});
it('keeps large legacy cent amounts exact at both named value boundaries',async()=>{
 const source=await upsertPayComponent(ctx,{...item,code:'LARGE_CENTS',name:'Large legacy cents',rule:{kind:'qty_rate',qty:33333333.33,rate:1}});
 await setEmploymentPayComponent(ctx,{employmentId:employee.employmentId,componentId:source.id,amount:1,effectiveFrom:context.period+'-01'});
 const saved=await savePayFormula(ctx,{formulaId:'LARGE',description:'Legacy monetary boundary',method:'write',source:'If {#PayItem}("LARGE_CENTS") = 33333333.33 And {#PayItemNoProrate}("LARGE_CENTS") = 33333333.33 Then\n Return 1\nElse\n Return 0\nEnd If'});
 const result=await testPayFormula(ctx,{...saved,context});expect(result.amount).toBe('1');
});
it('uses the Native normalized reference for legacy lowercase stored Pay Item codes',async()=>{
 const legacy=await upsertPayComponent(ctx,{...item,code:'LOWER_A',name:'Legacy stored casing',rule:{kind:'fixed'}});
 await setEmploymentPayComponent(ctx,{employmentId:employee.employmentId,componentId:legacy.id,amount:4.56,effectiveFrom:context.period+'-01'});
 await owner.db.update(schema.payComponent).set({code:'lower_a'}).where(eq(schema.payComponent.id,legacy.id));
 const saved=await savePayFormula(ctx,{formulaId:'CASING',description:'Preserved legacy identity',method:'write',source:'Return {#PayItem}("LOWER_A") + {#PayItemNoProrate}("LOWER_A") + {#PayItemInput}("LOWER_A")'});
 const result=await testPayFormula(ctx,{...saved,context});expect(result.passed,result.error??'normalized legacy code').toBe(true);expect(result.amount).toBe('13.68');
});
