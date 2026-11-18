import {randomUUID} from 'node:crypto';
import {createMovementEvent,movementHistory,reverseMovementEvent} from '../core/movement';
import {personnelBusinessCodeChoicesTx,personnelBusinessCodeValueTx,personnelBusinessGradeAtTx} from '../core/pay-formula-business-codes';
import {personnelFormulaLibraryTx} from '../core/pay-formula-personnel';
import {personnelFormulaPermissionsTx} from '../core/pay-formula-personnel-permissions';
import {resolvePayrollPermission} from '../core/payroll';
import {PAY_FORMULA_BUSINESS_CODE_PROVIDER_VERSION} from '../lib/pay-formula-personnel';
import {todayInKualaLumpur} from '../lib/hr-date';
import {PAY_FORMULA_PERSONNEL_PROVIDER_VERSION} from '../lib/pay-formula-personnel';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {sql,eq} from 'drizzle-orm';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {seedPayComponentCatalog,upsertPayComponent,setEmploymentPayComponent} from '../core/pay-components';
import {createBatch,createAdditionalRun,generatePayslips} from '../core/payroll';
import {registerPayFormulaPersonnelField,payFormulaOptions,savePayFormula,testPayFormula,setPayFormulaActive,getFormulaEvaluation,saveFormulaAccumulationGroup} from '../core/pay-formula';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {withTenant,type SessionContext} from '../db/client';
import type {PayFormulaContext} from '../lib/pay-formula-model';
let base:Base,ctx:SessionContext,employee:{employmentId:string;personId:string},context:PayFormulaContext;
const item={code:'EXACT_FORMULA',name:'Exact formula allowance',label:'Exact formula allowance',kind:'allowance' as const,includedInEpf:false,includedInSocsoEis:false,includedInPcb:false,includedInHrdfBase:false,isNonPayable:false,prorates:false,formulaContext:{rate:'1.005'}};
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();base=await seedBase();await setModule(base.tenantId,'typed_pay_components','active');ctx=await entitledCtx(base);
 employee=await hireEmployee(ctx,{person:{fullName:'Fictional runtime employee',primaryEmail:'formula-runtime@example.invalid'},companyId:base.companyId,departmentId:base.deptA,positionId:base.positionId,employmentType:'full_time',hiredOn:'2026-01-01'});
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

async function configuredCodes(){
 await owner.db.update(schema.company).set({companyLabel:'ARIU'}).where(eq(schema.company.id,base.companyId));
 await owner.db.update(schema.department).set({name:'DP0005',label:'Finance team',isGlobal:true}).where(eq(schema.department.id,base.deptA));
 await owner.db.update(schema.position).set({title:'J0113',label:'Equipment controller',isGlobal:true}).where(eq(schema.position.id,base.positionId));
 const [unit]=await owner.db.insert(schema.businessUnit).values({tenantId:base.tenantId,companyId:base.companyId,code:'GCHBM',name:'Operating business',label:'Business label',isGlobal:true}).returning();
 const [grade]=await owner.db.insert(schema.jobGrade).values({tenantId:base.tenantId,code:'JG17',name:'Senior technical grade'}).returning();
 await owner.db.update(schema.assignment).set({businessUnitId:unit.id}).where(eq(schema.assignment.employmentId,employee.employmentId));
 await owner.db.update(schema.employment).set({gradeId:grade.id}).where(eq(schema.employment.id,employee.employmentId));
 return {unit,grade};
}

it('uses actual Code columns in preview and native processing while saved ID/alias programs retain their values',async()=>{
 await configuredCodes();
 const source='If {#EmployeeProfile}("companyCode") = "ARIU" And {#EmployeeProfile}("departmentBusinessCode") = "DP0005" And {#EmployeeProfile}("positionBusinessCode") = "J0113" And {#EmployeeProfile}("businessUnitCode") = "GCHBM" And {#EmployeeProfile}("jobGradeCode") = "JG17" Then\nReturn 123.45\nElse\nReturn 0\nEnd If';
 const simulated=await activate(source);expect(simulated.amount).toBe('123.45');
 const legacy=await savePayFormula(ctx,{formulaId:'OLD_ALIASES',description:'Legacy meaning',method:'write',source:`If {#EmployeeProfile}("positionCode") = "J0113" And {#EmployeeProfile}("departmentCode") = "DP0005" And {#EmployeeProfile}("positionId") = "${base.positionId}" Then\nReturn 7\nElse\nReturn 0\nEnd If`});
 expect((await testPayFormula(ctx,{...legacy,context})).amount).toBe('7');
 const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:context.period,payrollCycleId:context.cycleId});await generatePayslips(ctx,{batchId});
 const [slip]=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId));
 expect((slip.statutory as {componentLines:{code:string;amount:number}[]}).componentLines.find(line=>line.code===item.code)?.amount).toBe(123.45);
 const [evidence]=await owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.batchId,batchId));
 expect(JSON.stringify(evidence.payload)).toContain(PAY_FORMULA_BUSINESS_CODE_PROVIDER_VERSION);
 const options=await payFormulaOptions(ctx);
 for(const [key,value]of [['positionBusinessCode','J0113'],['departmentBusinessCode','DP0005'],['businessUnitCode','GCHBM'],['jobGradeCode','JG17']])expect(options.personnelFields.find(field=>field.key===key)).toMatchObject({enabled:true,dateBasis:'effective-date',listValues:expect.arrayContaining([expect.objectContaining({value})])});
});

it('resolves the assignment and grade at the selected payroll date and excludes reversed changes',async()=>{
 const {grade}=await configuredCodes();
 const [nextGrade]=await owner.db.insert(schema.jobGrade).values({tenantId:base.tenantId,code:'JG18',name:'Different senior grade'}).returning();
 await owner.db.update(schema.department).set({name:'DP0006',isGlobal:true}).where(eq(schema.department.id,base.deptB));
 await createMovementEvent(ctx,{employmentId:employee.employmentId,kind:'transfer',effectiveDate:'2026-05-10',departmentId:base.deptB});
 await createMovementEvent(ctx,{employmentId:employee.employmentId,kind:'promotion',effectiveDate:'2026-05-15',gradeId:nextGrade.id});
 const read=(asOf:string)=>withTenant(ctx,async tx=>({department:(await personnelBusinessCodeValueTx(tx,ctx,{employmentId:employee.employmentId,companyId:base.companyId,asOf,key:'departmentBusinessCode'}))?.value,grade:await personnelBusinessGradeAtTx(tx,ctx.tenantId,employee.employmentId,asOf)}));
 expect(await read('2026-05-01')).toEqual({department:'DP0005',grade:grade.id});
 expect(await read('2026-05-20')).toEqual({department:'DP0006',grade:nextGrade.id});
 const promotion=(await movementHistory(ctx,employee.employmentId)).find(row=>row.kind==='promotion')!;
 await reverseMovementEvent(ctx,{employmentId:employee.employmentId,movementId:promotion.id,reason:'Fictional reversal'});
 expect((await read('2026-05-20')).grade).toBe(grade.id);
});

it('fails closed for archived or missing configured code, without substituting a label or UUID',async()=>{
 await configuredCodes();
 const saved=await savePayFormula(ctx,{formulaId:'MISSING_CODE',description:'Missing source refusal',method:'write',source:'If {#EmployeeProfile}("positionBusinessCode") = "J0113" Then\nReturn 1\nElse\nReturn 0\nEnd If'});
 await owner.db.update(schema.position).set({archivedAt:new Date()}).where(eq(schema.position.id,base.positionId));
 expect(await testPayFormula(ctx,{...saved,context})).toMatchObject({passed:false,error:expect.stringContaining('positionBusinessCode')});
 expect((await payFormulaOptions(ctx)).personnelFields.find(field=>field.key==='positionBusinessCode')?.listValues).toEqual([]);
});

it('retains old registration and adds audited registrations for the new code vocabulary',async()=>{
 await configuredCodes();
 await registerPayFormulaPersonnelField(ctx,{sourceKey:'positionBusinessCode',label:'Position code',description:'Configured System Labels Code',enabled:false});
 expect((await payFormulaOptions(ctx)).personnelFields.find(field=>field.key==='positionBusinessCode')).toMatchObject({enabled:false,unavailableReason:'disabled',listValues:[]});
 const saved=()=>savePayFormula(ctx,{formulaId:'DISABLED',description:'Disabled source',method:'write',source:'If {#EmployeeProfile}("positionBusinessCode") = "J0113" Then\nReturn 1\nElse\nReturn 0\nEnd If'});
 await expect(saved()).rejects.toThrow(/disabled/);
 const original=await savePayFormula(ctx,{formulaId:'COMPATIBLE',description:'ID still available',method:'write',source:`If {#EmployeeProfile}("positionId") = "${base.positionId}" Then\nReturn 1\nElse\nReturn 0\nEnd If`});
 expect((await testPayFormula(ctx,{...original,context})).amount).toBe('1');
});

it('batches company field grants exactly like the permission owner, preserving narrowed carriers',async()=>{
 await configuredCodes();
 const [second]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Other permitted company'}).returning();
 await owner.db.insert(schema.payrollPermissionGrant).values({tenantId:base.tenantId,companyId:base.companyId,role:'hr_admin',permissionKey:'report.read.personnel',allowed:false});
 for(const actor of [ctx,{...ctx,roles:[],grants:[]}])await withTenant(actor,async tx=>{
  const batch=await personnelFormulaPermissionsTx(tx,actor,[base.companyId,second.id],['report.read.personnel']);
  for(const companyId of [base.companyId,second.id])expect(batch.get('report.read.personnel')?.has(companyId)).toBe(await resolvePayrollPermission(tx,actor,'report.read.personnel',companyId));
 });
 const options=await payFormulaOptions(ctx);expect(options.personnelFields.find(field=>field.key==='companyCode')?.listValues.some(value=>value.value==='ARIU')).toBe(false);
});

it('SQL-pages code choices across 70 companies/1000 employments and retains the prior ID list order/values',async()=>{
 await configuredCodes();
 const companies=await owner.db.insert(schema.company).values(Array.from({length:69},(_,index)=>({tenantId:base.tenantId,legalName:`Company ${index}`,companyLabel:`CO${String(index).padStart(3,'0')}`}))).returning();
 const people=await owner.db.insert(schema.person).values(Array.from({length:1000},(_,index)=>({tenantId:base.tenantId,fullName:`Formula scale ${index}`}))).returning({id:schema.person.id});
 await owner.db.insert(schema.employment).values(people.map((person,index)=>({tenantId:base.tenantId,personId:person.id,companyId:companies[index%companies.length].id,hiredOn:'2026-01-01',employeeCode:`FX${index}`})));
 const codes=Array.from({length:125},(_,index)=>({tenantId:base.tenantId,companyId:companies[index%69].id,title:`P${String(index).padStart(4,'0')}`,label:`Position label ${index}`,isGlobal:true}));
 await owner.db.insert(schema.position).values(codes);
 const companyRows=[{id:base.companyId,name:'Base'},...companies.map(company=>({id:company.id,name:company.legalName}))];
 await withTenant(ctx,async tx=>{
  const all=await personnelBusinessCodeChoicesTx(tx,ctx,companyRows.map(company=>company.id),'positionBusinessCode');
  const second=await personnelBusinessCodeChoicesTx(tx,ctx,companyRows.map(company=>company.id),'positionBusinessCode','',50);
  expect(all.total).toBe(126);expect(all.items).toHaveLength(50);expect(second.items).toHaveLength(50);
  expect(all.items.map(item=>item.value)).toEqual(['J0113',...Array.from({length:49},(_,index)=>`P${String(index).padStart(4,'0')}`)]);
  expect(second.items[0].value).toBe('P0049');
  const one=await personnelBusinessCodeChoicesTx(tx,ctx,[base.companyId],'positionBusinessCode');expect(one).toEqual(all);
  const old=await tx.execute<{value:string;label:string}>(sql`select id::text as value,title||' · '||id::text as label from position where tenant_id=${base.tenantId}::uuid and archived_at is null and is_global order by label`);
  let statements=0;const counted=new Proxy(tx,{get(target,key,receiver){const value=Reflect.get(target,key,receiver);return key==='execute'?function(...args:unknown[]){statements++;return Reflect.apply(value,target,args);}:typeof value==='function'?value.bind(target):value;}});
  const library=await personnelFormulaLibraryTx(counted,ctx,companyRows);
  expect(library.find(field=>field.key==='positionId')?.listValues).toEqual(old);
  // Registration + two batched authority reads + ID catalogue + five bounded code pages; independent of company/employee count.
  expect(statements).toBe(9);
 });
},120_000);
