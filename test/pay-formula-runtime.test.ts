import {todayInKualaLumpur} from '../lib/hr-date';
import {PAY_FORMULA_PERSONNEL_PROVIDER_VERSION} from '../lib/pay-formula-personnel';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {sql,eq} from 'drizzle-orm';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {seedPayComponentCatalog,upsertPayComponent,setEmploymentPayComponent} from '../core/pay-components';
import {createBatch,generatePayslips} from '../core/payroll';
import {registerPayFormulaPersonnelField,payFormulaOptions,savePayFormula,testPayFormula,setPayFormulaActive,getFormulaEvaluation,saveFormulaAccumulationGroup} from '../core/pay-formula';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {withTenant,type SessionContext} from '../db/client';
import type {PayFormulaContext} from '../lib/pay-formula-model';
let base:Base,ctx:SessionContext,employee:{employmentId:string;personId:string},context:PayFormulaContext;
const item={code:'EXACT_FORMULA',name:'Exact formula allowance',label:'Exact formula allowance',kind:'allowance' as const,includedInEpf:false,includedInSocsoEis:false,includedInPcb:false,includedInHrdfBase:false,isNonPayable:false,prorates:false,formulaContext:{rate:'1.005'}};
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();base=await seedBase();await setModule(base.tenantId,'typed_pay_components','active');ctx=await entitledCtx(base);
 employee=await hireEmployee(ctx,{person:{fullName:'Fictional runtime employee',primaryEmail:'formula-runtime@example.invalid'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});
 await setCompensation(ctx,{employmentId:employee.employmentId,basicSalary:5000,monthlyAllowance:0,effectiveFrom:'2026-01-01'});
 await setStatutoryProfileMY(ctx,{personId:employee.personId,icNumber:'900101011234'});await seedPayComponentCatalog(ctx);
 // Preserve the existing standalone formula-test context. Explicit fixed intent deliberately clears
 // rate bindings; a legacy unset-rule receiver is the supported fixture for testing named bindings.
 await upsertPayComponent(ctx,{...item,rule:null});
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
 const formulaContext={ordinaryRate:'26',hoursPerDay:'8',rate:'1.5'};await upsertPayComponent(ctx,{...item,formulaContext,rule:null});
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
 const source=await upsertPayComponent(ctx,{...item,code:'LARGE_CENTS',name:'Large legacy cents',rule:{kind:'qty_rate',qty:1,rate:33333333.33}});
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
it('uses the Native period-end salary owner when testing an existing run',async()=>{
 await setCompensation(ctx,{employmentId:employee.employmentId,basicSalary:6200,monthlyAllowance:0,effectiveFrom:'2026-05-16'});
 const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:context.period,payrollCycleId:context.cycleId});
 context={...context,asOf:'2026-05-10',batchId} as PayFormulaContext;
 const tested=await activate('Return {#Basic} / 10');expect(tested.amount).toBe('620');
 await generatePayslips(ctx,{batchId});
 const [slip]=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId));
 expect(slip.basicSalary).toBe('6200.00');expect((slip.statutory as {componentLines:{code:string;amount:number}[]}).componentLines.find(l=>l.code===item.code)?.amount).toBe(620);
});

it('uses stable Company identities for both EBAC-style overtime branches through the native source owner',async()=>{
 await owner.db.update(schema.company).set({legalName:'EBAC HOME SDN BHD'}).where(eq(schema.company.id,base.companyId));
 const allowance=await upsertPayComponent(ctx,{...item,code:'COMPANY_FIXED',name:'Company fixed allowance',orpOvertime:true,rule:null});
 await setEmploymentPayComponent(ctx,{employmentId:employee.employmentId,componentId:allowance.id,amount:1000,effectiveFrom:context.period+'-01'});
 const source=(companyId:string)=>`If {#EmployeeProfile}("companyId") = "${companyId}" Then\n Return ({#Basic} + {#FixedAllowances}) / 26 / 8 * 1.5 * {#Input}\nElse\n Return {#Basic} / 26 / 8 * 1.5 * {#Input}\nEnd If`;
 const yes=await savePayFormula(ctx,{formulaId:'COMPANY_YES',description:'Company branch',method:'write',source:source(base.companyId)}),no=await savePayFormula(ctx,{formulaId:'COMPANY_NO',description:'Other-company branch',method:'write',source:source('10000000-0000-4000-8000-000000000009')});
 expect((await testPayFormula(ctx,{...yes,context})).amount).toBe('129.81');expect((await testPayFormula(ctx,{...no,context})).amount).toBe('108.17');
 const [duplicateLabel]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'EBAC HOME SDN BHD'}).returning();
 const options=await payFormulaOptions(ctx),field=options.personnelFields.find(f=>f.key==='companyId');expect(field?.listValues).toContainEqual({value:base.companyId,label:'EBAC HOME SDN BHD · '+base.companyId});expect(field?.listValues).toContainEqual({value:duplicateLabel.id,label:'EBAC HOME SDN BHD · '+duplicateLabel.id});
});
it('refuses current-only history and sensitive authoring while retaining the existing formula contract',async()=>{
 const historical=await savePayFormula(ctx,{formulaId:'PAST',description:'No current-as-past source',method:'write',source:'{#Explain}({#EmployeeInformation}("profile.personal_details.fullname"))\nReturn 1'});
 expect(await testPayFormula(ctx,{...historical,context})).toMatchObject({passed:false,error:expect.stringContaining('current-only')});
 await owner.db.insert(schema.payrollPermissionGrant).values(['hr_admin','super_admin'].map(role=>({tenantId:base.tenantId,companyId:base.companyId,role,permissionKey:'report.read.identity',allowed:false})));
 await expect(savePayFormula(ctx,{formulaId:'DENIED_FIELD',description:'Denied sensitive source',method:'write',source:'{#Explain}({#EmployeeInformation}("profile.personal_details.fullname"))\nReturn 1'})).rejects.toThrow(/permission/);
});
it('versions only affected registrations, rejects executable source configuration and retains old formula receipts',async()=>{
 const old=await savePayFormula(ctx,{formulaId:'OLD_CONTRACT',description:'Unchanged old dependency receipt',method:'write',source:'Return {#Basic} / 10'}),fresh=await savePayFormula(ctx,{formulaId:'NEW_CONTRACT',description:'New Personnel dependency receipt',method:'write',source:`If {#EmployeeProfile}("companyId") = "${base.companyId}" Then\nReturn 1\nElse\nReturn 0\nEnd If`});
 const oldTest=await testPayFormula(ctx,{...old,context});expect(oldTest.passed).toBe(true);
 await registerPayFormulaPersonnelField(ctx,{sourceKey:'companyId',label:'Legal employer',description:'Verified legal company identity',enabled:true});
 expect((await testPayFormula(ctx,{...old,context})).amount).toBe(oldTest.amount);
 await expect(testPayFormula(ctx,{...fresh,context})).rejects.toThrow(/Dependencies changed/);
 await expect(registerPayFormulaPersonnelField(ctx,{sourceKey:'person; drop table company',label:'Forbidden',description:'No executable source registrations',enabled:true})).rejects.toThrow(/supported typed source/);
 const events=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.eventType,'pay-formula.personnel-registered'));expect(events).toHaveLength(1);
 await expect(withTenant(ctx,tx=>tx.execute(sql`update pay_formula_personnel_registration set enabled=false`))).rejects.toBeDefined();
});

it('reads actual current text, number and date scalars through their typed adapters',async()=>{
 const today=todayInKualaLumpur(),current={...context,period:today.slice(0,7),asOf:today};
 await owner.db.update(schema.employment).set({probationValue:6,contractStartDate:'2026-01-01'}).where(eq(schema.employment.id,employee.employmentId));
 const source='If {#EmployeeInformation}("profile.personal_details.fullname") = "Fictional runtime employee" And {#EmployeeProfile}("employment.employment_dates_and_service.probationvalue") = 6 And {#EmployeeProfile}("employment.employment_dates_and_service.contractstartdate") = {#Date}("2026-01-01") Then\nReturn 11.25\nElse\nReturn 0\nEnd If';
 const saved=await savePayFormula(ctx,{formulaId:'TYPED_CURRENT',description:'Native typed scalar boundaries',method:'write',source});
 expect(await testPayFormula(ctx,{...saved,context:current})).toMatchObject({passed:true,amount:'11.25'});
});
it('uses only exact-run native payslip-referenced frozen reads with the matching Personnel provider and date',async()=>{
 await activate('Return 1');const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:context.period,payrollCycleId:context.cycleId});await generatePayslips(ctx,{batchId});
 const key='profile.personal_details.fullname',source=`If {#EmployeeInformation}("${key}") = "Frozen historical name" Then\nReturn 9\nElse\nReturn 0\nEnd If`,saved=await savePayFormula(ctx,{formulaId:'FROZEN_PERSONNEL',description:'Exact native run snapshot',method:'write',source});
 const [slip]=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId));
 const payload={explanations:[],reads:[{code:'EmployeeInformation',args:[{type:'string',value:key}],loc:{line:1,column:1},value:{type:'string',value:'Frozen historical name'}}],sources:{context:{...context,batchId},sourceEvidence:[{owner:'typed-personnel',provider:PAY_FORMULA_PERSONNEL_PROVIDER_VERSION,key,dateBasis:'current-only',asOf:context.asOf}]}};
 // An owner-created historical native fixture represents a retained source read from that payroll day.
 const [evidence]=await owner.withTenant(ctx,tx=>tx.insert(schema.payFormulaEvaluation).values({tenantId:base.tenantId,formulaId:saved.id,revisionId:saved.revisionId,companyId:base.companyId,employmentId:employee.employmentId,batchId,componentCode:item.code,period:context.period,amount:'9',payload,readRequirements:{categories:['identity'],fieldIds:[key],workforce:true},actorId:ctx.userId!}).returning());
 await owner.db.update(schema.payslip).set({statutory:{...slip.statutory,formulaEvaluations:[{evaluationId:evidence.id}]}}).where(eq(schema.payslip.id,slip.id));
 await owner.db.update(schema.person).set({fullName:'Changed live employee name'}).where(eq(schema.person.id,employee.personId));
 const alternate=await createBatch(ctx,{companyId:base.companyId,payPeriod:context.period,payrollCycleId:context.cycleId});
 expect(await testPayFormula(ctx,{...saved,context:{...context,batchId:alternate.batchId}})).toMatchObject({passed:false,error:expect.stringContaining('current-only')});
 const selected={...context,batchId};expect(await testPayFormula(ctx,{...saved,context:selected})).toMatchObject({passed:true,amount:'9'});
 expect(await testPayFormula(ctx,{...saved,context:{...selected,asOf:'2026-05-30'}})).toMatchObject({passed:false,error:expect.stringContaining('current-only')});
 const [wrongProvider]=await owner.withTenant(ctx,tx=>tx.insert(schema.payFormulaEvaluation).values({...evidence,id:undefined,payload:{...payload,sources:{...payload.sources,sourceEvidence:[{...payload.sources.sourceEvidence[0],provider:'unreviewed-provider'}]}}}).returning());
 await owner.db.update(schema.payslip).set({statutory:{...slip.statutory,formulaEvaluations:[{evaluationId:wrongProvider.id}]}}).where(eq(schema.payslip.id,slip.id));
 expect(await testPayFormula(ctx,{...saved,context:selected})).toMatchObject({passed:false,error:expect.stringContaining('current-only')});
 await owner.db.update(schema.payslip).set({statutory:{...slip.statutory,formulaEvaluations:[]}}).where(eq(schema.payslip.id,slip.id));
 expect(await testPayFormula(ctx,{...saved,context:selected})).toMatchObject({passed:false,error:expect.stringContaining('current-only')});
});
it('requires administrator authority at both registration boundaries and refuses malformed native sources and forged audits',async()=>{
 const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,workosUserId:'formula-personnel-unprivileged',personId:employee.personId}).returning();
 const unprivileged={...ctx,userId:user.id,personId:employee.personId,roles:[],grants:[]} satisfies SessionContext;
 await expect(registerPayFormulaPersonnelField(unprivileged,{sourceKey:'companyId',label:'Employer',description:'A legitimate description does not grant authority',enabled:true})).rejects.toThrow();
 await expect(withTenant(unprivileged,tx=>tx.execute(sql`select app.pay_formula_personnel_register('companyId','Employer','A direct call does not grant authority',true)`))).rejects.toBeDefined();
 await expect(withTenant(ctx,tx=>tx.execute(sql`select app.pay_formula_personnel_register('person; DROP TABLE company','Employer','No native executable source registration',true)`))).rejects.toBeDefined();
 await expect(withTenant(ctx,tx=>tx.insert(schema.domainEvent).values({tenantId:base.tenantId,aggregateType:'pay-formula-personnel-registration',aggregateId:user.id,eventType:'pay-formula.personnel-registered',actorType:'user',actorId:ctx.userId!,payload:{sourceKey:'companyId'}}))).rejects.toBeDefined();
});
