import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {eq} from 'drizzle-orm';
import * as schema from '../db/schema';
import {type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {seedPayComponentCatalog,upsertPayComponent} from '../core/pay-components';
import {savePayFormula} from '../core/pay-formula';
import {previewIndividualTxnInput} from '../packs/payroll/individual-calculation';
import {createIndividualTxnsBulk,updateIndividualTxn,getIndividualTxn} from '../core/payroll-individual-txn';
import {createBatch,generatePayslips} from '../core/payroll';
import {closeAll,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,setSetting,type Base} from './harness';
let base:Base,ctx:SessionContext,employee:string,componentId:string,cycleId:string;
const period='2026-05',date=period+'-10';
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();base=await seedBase();await setModule(base.tenantId,'typed_pay_components','active');await setSetting(base.tenantId,'payroll.individual_txn_pay_enabled',true);ctx=await entitledCtx(base);
 const hired=await hireEmployee(ctx,{person:{fullName:'Fictional input-method employee',primaryEmail:'input-method@example.invalid'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2026-01-01'});employee=hired.employmentId;
 await setCompensation(ctx,{employmentId:employee,basicSalary:5000,monthlyAllowance:0,effectiveFrom:'2026-01-01'});await setStatutoryProfileMY(ctx,{personId:hired.personId,icNumber:'900101011234'});await seedPayComponentCatalog(ctx);
 const [cycle]=await owner.db.insert(schema.payrollCycle).values({tenantId:base.tenantId,companyId:base.companyId,name:'Method monthly cycle',code:'METHOD',runType:'regular'}).returning();cycleId=cycle.id;
 await savePayFormula(ctx,{formulaId:'ENTRY_METHOD',description:'25 per input',method:'write',source:'Return {#Input} * 25'});
 const c=await upsertPayComponent(ctx,{code:'ENTRY_TEST',name:'Entry method allowance',label:'Entry method allowance',kind:'allowance',includedInEpf:false,includedInSocsoEis:false,includedInPcb:false,includedInHrdfBase:false,isNonPayable:false,prorates:true,roundingMethod:'up',rule:{kind:'formula_builder',formulaId:'ENTRY_METHOD',dependencies:[]}});componentId=c.id;
});
async function create(method:'amount'|'formula'|undefined,amount:number,quantity:number|null,unit:string){
 return createIndividualTxnsBulk(ctx,{companyId:base.companyId,payPeriod:period,employmentIds:[employee],intendedCycleId:cycleId,rows:[{kind:'earning',componentId,txnDate:date,amount,quantity,unit,...(method?{calculationMethod:method}:{})}]});
}
it.each(['qty','hours','days','units'])('calculates %s with the saved formula and ignores the browser amount',async unit=>{
 const preview=await previewIndividualTxnInput(ctx,{componentId,employmentId:employee,companyId:base.companyId,payPeriod:period,txnDate:date,amount:999,quantity:2,unit,method:'formula',cycleId});expect(preview.amount).toBe(50);
 const {ids}=await create('formula',999,2,unit);const row=await getIndividualTxn(ctx,{id:ids[0]});expect(row).toMatchObject({amount:'50.00',quantity:'2.00',unit,calculationMethod:'formula'});
});
it('round trips quantity → Amount → quantity on the same saved transaction',async()=>{
 const {ids}=await create('formula',999,2,'hours');const id=ids[0];
 await updateIndividualTxn(ctx,{id,amount:123.45,quantity:null,unit:'amount',calculationMethod:'amount'});expect(await getIndividualTxn(ctx,{id})).toMatchObject({amount:'123.45',quantity:null,unit:'amount',calculationMethod:'amount'});
 await updateIndividualTxn(ctx,{id,amount:999,quantity:3,unit:'days',calculationMethod:'formula'});expect(await getIndividualTxn(ctx,{id})).toMatchObject({amount:'75.00',quantity:'3.00',unit:'days',calculationMethod:'formula'});
});
it('pays explicit final amounts once while retaining the legacy raw-input interpretation',async()=>{
 const legacy=await create(undefined,2,null,'amount');await create('amount',100,null,'amount');await create('formula',999,2,'qty');
 expect((await getIndividualTxn(ctx,{id:legacy.ids[0]}))?.calculationMethod).toBeNull();
 const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:period,payrollCycleId:cycleId});await generatePayslips(ctx,{batchId});
 const [slip]=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId));
 expect(Number(slip.allowance)).toBe(200); // legacy 2×25 + final override 100 + final formula amount 50
 const evaluations=await owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.batchId,batchId));expect(evaluations).toHaveLength(1);expect(Number(evaluations[0].amount)).toBe(50);
});
it('does not calculate a manual override even if its linked formula can no longer evaluate',async()=>{
 await create('amount',125.25,null,'amount');
 // A newly saved expression may legitimately fail for Input=0; a manual amount never invokes it.
 const {payFormulaOptions,getPayFormula}=await import('../core/pay-formula');const option=(await payFormulaOptions(ctx)).activeFormulas.find(f=>f.formulaId==='ENTRY_METHOD')!;const view=await getPayFormula(ctx,option.id);
 await savePayFormula(ctx,{id:option.id,expectedRevisionId:view!.latest.id,formulaId:'ENTRY_METHOD',description:'Needs input',method:'write',source:'Return 100 / {#Input}'});
 const {batchId}=await createBatch(ctx,{companyId:base.companyId,payPeriod:period,payrollCycleId:cycleId});await generatePayslips(ctx,{batchId});
 const [slip]=await owner.db.select().from(schema.payslip).where(eq(schema.payslip.batchId,batchId));expect(Number(slip.allowance)).toBe(125.25);
 expect(await owner.db.select().from(schema.payFormulaEvaluation).where(eq(schema.payFormulaEvaluation.batchId,batchId))).toHaveLength(0);
});
it('refuses a bad quantity or contradictory manual input without writing any ledger row',async()=>{
 await expect(create('formula',999,null,'qty')).rejects.toThrow(/positive quantity/);
 await expect(create('formula',999,2,'amount')).rejects.toThrow(/positive quantity/);
 await expect(create('formula',999,0.125,'hours')).rejects.toThrow(/two decimal places/);
 await expect(create('amount',100,2,'amount')).rejects.toThrow(/must not include/);
 expect(await owner.db.select().from(schema.payrollIndividualTxn)).toHaveLength(0);
});
it('refuses a preview for a different company before returning calculated employee data',async()=>{
 const [company]=await owner.db.insert(schema.company).values({tenantId:base.tenantId,legalName:'Different fictional company',registrationNo:'METHOD-OTHER'}).returning();
 await expect(previewIndividualTxnInput(ctx,{componentId,employmentId:employee,companyId:company.id,payPeriod:period,txnDate:date,amount:0,quantity:2,unit:'qty',method:'formula',cycleId})).rejects.toThrow(/unavailable/);
});
