/** Authored UNRUN. Six actual native record projections through real Assistant read sessions.
 * No model/provider, injected moduleWork, fabricated read result, forged receipt or draft SQL install.
 * Finite specialist interpretation coverage only; not payroll correctness or production-benefit proof. */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import type {SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {createBusinessUnit} from '../core/admin';
import {setCompensation} from '../core/comp';
import {seedPayComponentCatalog,listPayComponents,setEmploymentPayComponent,upsertPayComponent} from '../core/pay-components';
import {createBatch,generatePayslips,closeBatch} from '../packs/payroll/service';
import {requirePackFor} from '../localization/registry';
import {createClaimType,submitClaim,decideClaim} from '../packs/claims/service';
import {createRewardUnit,getRewardUnit} from '../packs/rewards/service';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {withAssistantRead} from '../core/assistant-read-session';
import {executeSpecialistHoldout} from '../core/module-specialist-harness';
import {executeCanonicalSpecialist} from '../lib/ai/module-specialists';
import type {AgentModuleCode} from '../lib/ai/module-agents';
import type {JobCard,JobFactField} from '../lib/ai/module-jobs';
import {recordedPayrollComparisonCurrency} from '../lib/payroll-comparison-source';
import {todayInKualaLumpur} from '../lib/hr-date';
import {CORE_MODULE_CODES} from '../packs/catalog';
import {closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
let b:Base;
const today=todayInKualaLumpur(),date=new Date(today+'T00:00:00Z');date.setUTCMonth(date.getUTCMonth()-1,1);
const period=date.toISOString().slice(0,7),effectiveFrom=`${date.getUTCFullYear()-2}-01-01`;
const financialModules=['payroll','multi_cycle_payroll','typed_pay_components'] as const;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();for(const module of ['assistant','payroll','multi_cycle_payroll','typed_pay_components','country-my','rewards','claims'].filter(code=>!CORE_MODULE_CODES.includes(code)))await setModule(b.tenantId,module,'active');});
type NativeSubject=Awaited<ReturnType<typeof hireEmployee>>;
async function fixture(){
 const admin:SessionContext={...await entitledCtx(b),grants:[{role:'hr_admin',companyId:null}]};
 const {id:businessUnitId}=await createBusinessUnit(admin,{companyId:b.companyId,code:'SPECIALIST',name:'Fictional specialist unit'});
 const hire=(name:string)=>hireEmployee(admin,{person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,businessUnitId,employmentType:'full_time',hiredOn:effectiveFrom});
 const mine=await hire('Fictional current specialist subject'),peer=await hire('PRIVATE_OTHER_SPECIALIST_PERSON');
 const userId=await createAppUser(b.tenantId,mine.personId,'employee');await grantAssistant(admin,{appUserId:userId});
 const ctx:SessionContext={...await entitledCtx(b,['employee']),userId,personId:mine.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 return {admin,ctx,mine,peer,businessUnitId};
}
const configuration=(module:AgentModuleCode)=>({kind:'canonical_specialist_v1',module,playbook:'canonical_domain_v1'});
async function assess(ctx:SessionContext,module:AgentModuleCode){
 return withAssistantRead(ctx,module,async read=>{
  const actual=await read.moduleWork(module);
  expect(actual).toMatchObject({module,scope:'current-caller'});
  const assessment=executeCanonicalSpecialist(configuration(module),actual),report=await executeSpecialistHoldout(configuration(module),read);
  expect(report).toMatchObject({module,state:'complete',nativeEvidence:'present',coverage:'canonical_domain_guidance_only',qualityFailures:0,securityFailures:0});
  expect(report.cases.every(row=>row.passed)).toBe(true);
  expect(report.cases.find(row=>row.id===module+':fresh-native-facts-preserved')).toMatchObject({category:'native',passed:true});
  expect(report.cases.find(row=>row.id===module+':nonempty-business-evidence')).toMatchObject({category:'native',passed:true});
  expect(assessment.effects).toEqual([]);expect(assessment.requiresFreshNativeReview).toBe(true);expect(assessment.presentation.cards.length).toBeGreaterThan(0);
  return {assessment,report};
 });
}
const value=(card:JobCard,field:JobFactField)=>card.facts.find(fact=>fact.field===field)?.value;
async function revoke(admin:SessionContext,ctx:SessionContext,modules:readonly AgentModuleCode[]){await revokeAssistant(admin,{appUserId:ctx.userId!});for(const module of modules)await expect(withAssistantRead(ctx,module,read=>executeSpecialistHoldout(configuration(module),read))).rejects.toThrow();}
async function pay(admin:SessionContext,subject:NativeSubject,salary:number,identity:string){await setCompensation(admin,{employmentId:subject.employmentId,basicSalary:salary,monthlyAllowance:0,effectiveFrom});await requirePackFor('MY').statutory.set(admin,{personId:subject.personId,icNumber:identity});}
describe('real canonical financial and statutory specialist evidence',()=>{
 it('preserves actual released own Payroll, run-index and typed-component facts across all three specialists',async()=>{
  const f=await fixture();await pay(f.admin,f.mine,7319,'910707030001');await pay(f.admin,f.peer,9327,'910707030002');
  await seedPayComponentCatalog(f.admin);const basic=(await listPayComponents(f.admin)).find(row=>row.code==='BASIC');expect(basic).toBeTruthy();if(!basic)throw Error('Native basic component missing');
  await setEmploymentPayComponent(f.admin,{employmentId:f.mine.employmentId,componentId:basic.id,amount:7319,effectiveFrom});
  await upsertPayComponent(f.admin,{label:'Fictional stored specialist allowance',code:'SPECIALIST_ALLOWANCE',name:'Fictional stored specialist allowance',kind:'allowance',includedInEpf:true,includedInSocsoEis:true,includedInPcb:true,includedInHrdfBase:false,isNonPayable:false,prorates:true,roundingMethod:'none'});
  const allowance=(await listPayComponents(f.admin)).find(row=>row.code==='SPECIALIST_ALLOWANCE');expect(allowance).toBeTruthy();if(!allowance)throw Error('Native allowance component missing');await setEmploymentPayComponent(f.admin,{employmentId:f.mine.employmentId,componentId:allowance.id,amount:120,effectiveFrom});
  const {batchId}=await createBatch(f.admin,{companyId:b.companyId,payPeriod:period});await generatePayslips(f.admin,{batchId});await closeBatch(f.admin,{batchId});
  const [mine]=await owner.db.select().from(s.payslip).where(and(eq(s.payslip.batchId,batchId),eq(s.payslip.employmentId,f.mine.employmentId))),peers=await owner.db.select().from(s.payslip).where(and(eq(s.payslip.batchId,batchId),eq(s.payslip.employmentId,f.peer.employmentId)));
  expect(mine).toBeTruthy();expect(peers.length).toBeGreaterThan(0);
  const payroll=(await assess(f.ctx,'payroll')).assessment;expect(payroll.findings).toContain('released_pay_stored_only');expect(payroll.presentation.cards).toHaveLength(1);
  const card=payroll.presentation.cards[0];expect(value(card,'gross')).toBe(mine.grossPay);expect(value(card,'net')).toBe(mine.netPay);expect(value(card,'deductions')).toBe(mine.totalDeductions);expect(value(card,'currency')).toBe(recordedPayrollComparisonCurrency(mine.statutory,b.companyId));expect(card.href).toBe('/me/payslip/'+mine.id);
  const runs=(await assess(f.ctx,'multi_cycle_payroll')).assessment;expect(runs.findings).toContain('released_run_index_not_run_creation');expect(runs.presentation.cards).toHaveLength(1);expect(value(runs.presentation.cards[0],'period')).toBe(period);expect(runs.presentation.cards[0].href).toBe('/me/payslip/'+mine.id);
  const components=(await assess(f.ctx,'typed_pay_components')).assessment;expect(components.findings).toContain('component_amount_stored_only');const stored=mine.statutory as {componentLines?:{code?:string;amount?:unknown}[]};expect(stored.componentLines?.length).toBeGreaterThan(0);expect(components.presentation.cards.length).toBeGreaterThan(0);
  for(const line of components.presentation.cards){const original=stored.componentLines!.find(item=>item.code===value(line,'itemCode'));expect(original).toBeTruthy();expect(value(line,'amount')).toBe(original!.amount);expect(value(line,'currency')).toBe(recordedPayrollComparisonCurrency(mine.statutory,b.companyId));}
  for(const assessment of [payroll,runs,components]){expect(JSON.stringify(assessment)).not.toContain('PRIVATE_OTHER_SPECIALIST_PERSON');for(const peer of peers)expect(JSON.stringify(assessment)).not.toContain(peer.id);}
  await revoke(f.admin,f.ctx,financialModules);
 });
 it('interprets actual own Malaysian statutory readiness gaps without inventing rates or claiming filing',async()=>{
  const f=await fixture(),result=(await assess(f.ctx,'country-my')).assessment;
  expect(result.findings).toContain('readiness_gaps');expect(result.findings).toContain('statutory_gap_not_rate_decision');expect(value(result.presentation.cards[0],'checkedRecords')).toBe(1);
  expect(JSON.stringify(result)).not.toContain(f.peer.employmentId);expect(JSON.stringify(result)).not.toContain('PRIVATE_OTHER_SPECIALIST_PERSON');
  expect(result.presentation.cards.flatMap(row=>row.facts).some(fact=>fact.field==='amount')).toBe(false);
  await revoke(f.admin,f.ctx,['country-my']);
 });
 it('interprets real own pending and approved Claims without converting approval to payment or exposing peer expenses',async()=>{
  const f=await fixture(),type=await createClaimType(f.admin,{code:'SPECIALIST',name:'Fictional current expense',defaultTaxable:false,requiresReceipt:false,maxReceiptAgeDays:36500}),otherType=await createClaimType(f.admin,{code:'PRIVATE',name:'PRIVATE_OTHER_SPECIALIST_CLAIM',defaultTaxable:false,requiresReceipt:false,maxReceiptAgeDays:36500});
  const own=await submitClaim(f.admin,{employmentId:f.mine.employmentId,claimTypeId:type.id,amount:123.45,incurredOn:today});await submitClaim(f.admin,{employmentId:f.peer.employmentId,claimTypeId:otherType.id,amount:543.21,incurredOn:today});
  const pending=(await assess(f.ctx,'claims')).assessment;expect(pending.findings).toContain('claim_pending_not_approved');expect(pending.findings).not.toContain('claim_approved_not_paid');
  await decideClaim(f.admin,{claimRequestId:own.id,decision:'approve'});
  const approved=(await assess(f.ctx,'claims')).assessment;expect(approved.findings).toContain('claim_approved_not_paid');expect(approved.findings).not.toContain('claim_payment_recorded');expect(approved.presentation.cards).toHaveLength(1);expect(value(approved.presentation.cards[0],'status')).toBe('approved');
  for(const marker of ['123.45','543.21','PRIVATE_OTHER_SPECIALIST_CLAIM',f.peer.employmentId])expect(JSON.stringify(approved)).not.toContain(marker);
  await revoke(f.admin,f.ctx,['claims']);
 });
 it('interprets a real native Rewards draft and excludes another tenant without claiming an award or payroll post',async()=>{
  const f=await fixture();await setCompensation(f.admin,{employmentId:f.mine.employmentId,basicSalary:7319,monthlyAllowance:0,effectiveFrom});await grantAssistant(f.admin,{appUserId:f.admin.userId!});
  const id=await createRewardUnit(f.admin,{name:'Fictional native reward cycle',year:Number(today.slice(0,4)),companyId:b.companyId,businessUnitId:f.businessUnitId,snapshotDate:today});const native=await getRewardUnit(f.admin,id);expect(native.rows.length).toBeGreaterThan(0);
  const foreign=await seedBase();await setModule(foreign.tenantId,'rewards','active');const foreignAdmin=await entitledCtx(foreign),foreignUnit=await createBusinessUnit(foreignAdmin,{companyId:foreign.companyId,code:'FOREIGN',name:'PRIVATE_FOREIGN_SPECIALIST_UNIT'});await createRewardUnit(foreignAdmin,{name:'PRIVATE_FOREIGN_SPECIALIST_REWARDS',year:Number(today.slice(0,4)),companyId:foreign.companyId,businessUnitId:foreignUnit.id,snapshotDate:today});
  const result=(await assess(f.admin,'rewards')).assessment;expect(result.findings).toContain('reward_draft_not_awarded');expect(result.findings).not.toContain('reward_posted_not_processed_or_paid');expect(result.presentation.cards).toHaveLength(1);expect(value(result.presentation.cards[0],'status')).toBe('draft');expect(value(result.presentation.cards[0],'rewardUnit')).toBe(native.name);
  for(const marker of ['PRIVATE_FOREIGN_SPECIALIST_REWARDS','PRIVATE_FOREIGN_SPECIALIST_UNIT','7319',f.mine.personId])expect(JSON.stringify(result)).not.toContain(marker);
  await revoke(f.admin,f.admin,['rewards']);
 });
});
