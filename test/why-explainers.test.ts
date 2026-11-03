/** AI v2 W5 — "Why?" on pay, leave and claim figures over the REAL owners on fictional data.
 *
 * Two released months for one employee, with a salary rise in the second, and a colleague paid more in both. The
 * pay difference must reproduce the payroll service's own stored figures exactly (expected values are written from
 * the fixture and read independently off the payslip rows), carry the salary change the run recorded, and never
 * show the colleague's pay or an unreleased run. Through the harness the model receives placeholders only and the
 * person gets the exact figure back. The claim limit reproduces the claims owner's limit, use and what is left; the
 * leave panel's read reproduces the leave dashboard card. Another person's turn is offered no explainer. */
import {randomUUID} from 'node:crypto';
import {and,eq} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {closeBatch,createBatch,generatePayslips} from '../core/payroll';
import {createClaimType,setClaimPolicy,submitClaim} from '../core/claims';
import {leaveEntitlementBreakdown} from '../core/read';
import {projectMineLeaveEntitlement} from '../core/assistant-leave-projection';
import {explainOwnPayDifference} from '../core/explainers/pay-difference';
import {explainOwnClaimLimit} from '../core/explainers/claim-limit';
import {ownLeaveBalanceWhy,ownPayDifference} from '../core/explainers/own-why';
import {TERAS_CAPABILITIES} from '../core/explainers/capabilities';
import {setWorkerSwitch} from '../core/agent-registry/controls';
import {HARNESS_TEST_ONLY,runTurn} from '../core/harness/runner';
import {InMemoryTaskMemoryStore} from '../core/harness/memory';
import type {ModelRequest} from '../core/harness/model-client';
import {todayInKualaLumpur} from '../lib/hr-date';
import {scriptedModel,type ScriptStep} from './harness-ratchet/scripted-model';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,setModule,type Base} from './harness';

let base:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-why-passphrase');await resetDb();base=await seedBase();
 for(const code of ['assistant','payroll','claims'])await setModule(base.tenantId,code,'active');});

type Line={key:string;current:number;previous:number;change:number};
type Difference={ok:true;period:string;previousPeriod:string;comparisons:{company:string;lines:Line[];totals:{gross:Line;totalDeductions:Line;net:Line};
 causes:{kind:string;current:number|null;previous:number|null;effectiveFrom?:string|null}[];statutory:{key:string;ruleKind:string}[]}[]};

async function people(){
 const admin=adminCtx(base),uniq=randomUUID().slice(0,6);
 await seedEntitlement(admin,{leaveTypeId:base.annualLeaveTypeId,annualDays:14,validFrom:'2020-01-01'});
 const hire=(fullName:string)=>hireEmployee(admin,{person:{fullName,primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 const mine=await hire('Fictional Why Employee'),colleague=await hire('Fictional Why Colleague');
 for(const [row,salary,ic] of [[mine,5000,'900101012345'],[colleague,7300,'910202023456']] as const){
  await setCompensation(admin,{employmentId:row.employmentId,basicSalary:salary,effectiveFrom:'2024-01-01'});await setStatutoryProfileMY(admin,{personId:row.personId,icNumber:ic});}
 // A rise to 5,500 from 1 September: August and September are released, October is left open and must stay invisible.
 await setCompensation(admin,{employmentId:mine.employmentId,basicSalary:5500,effectiveFrom:'2026-09-01'});
 const batches:Record<string,string>={};
 for(const period of ['2026-08','2026-09','2026-10']){const batch=await createBatch(admin,{companyId:base.companyId,payPeriod:period});await generatePayslips(admin,{batchId:batch.batchId});
  if(period!=='2026-10')await closeBatch(admin,{batchId:batch.batchId});batches[period]=batch.batchId;}
 // Claims: one own Travel claim, and a larger one by the colleague that must not count against the employee.
 const year=todayInKualaLumpur().slice(0,4),today=todayInKualaLumpur();
 const travel=await createClaimType(admin,{code:'TRV'+uniq,name:'Travel '+uniq,defaultTaxable:false,requiresReceipt:false});
 await setClaimPolicy(admin,{claimTypeId:travel.id,annualBudget:2000,perClaimCap:500,effectiveFrom:`${year}-01-01`});
 await submitClaim(admin,{employmentId:mine.employmentId,claimTypeId:travel.id,amount:120,incurredOn:today});
 await submitClaim(admin,{employmentId:colleague.employmentId,claimTypeId:travel.id,amount:450,incurredOn:today});
 const employeeUser=await createAppUser(base.tenantId,mine.personId,'employee');await grantAssistant(admin,{appUserId:employeeUser});
 const employee:SessionContext={...await entitledCtx(base,['employee']),userId:employeeUser,personId:mine.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
 const person=await hire('Fictional Why Admin');
 const adminUser=await createAppUser(base.tenantId,person.personId,'hr_admin');await grantAssistant(admin,{appUserId:adminUser});
 const hr:SessionContext={...await entitledCtx(base,['hr_admin']),userId:adminUser,personId:person.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
 await setWorkerSwitch(hr,{workerId:'explainers',enabled:true});
 return{employee,hr,mine,colleague,batches,travel,uniq};
}
const stored=(employmentId:string,batchId:string)=>owner.db.select().from(schema.payslip).where(and(eq(schema.payslip.employmentId,employmentId),eq(schema.payslip.batchId,batchId))).then(rows=>rows[0]);
const turn=(ctx:SessionContext,question:string,script:readonly ScriptStep[])=>{const model=scriptedModel(script);
 return runTurn({enabled:HARNESS_TEST_ONLY,ctx,conversationId:randomUUID(),question,scope:{companyId:base.companyId,locale:'en'},model,memory:new InMemoryTaskMemoryStore()}).then(result=>({result,model}));};
function lastToolResult(request:ModelRequest):unknown{
 const tool=[...request.messages].reverse().find(message=>message.role==='tool');if(!tool)throw Error('No tool result sent.');
 return JSON.parse((tool.content as string).split('\n').slice(1,-1).join('\n'));
}
const numbers=(value:unknown):number[]=>typeof value==='number'?[value]:Array.isArray(value)?value.flatMap(numbers):value&&typeof value==='object'?Object.values(value).flatMap(numbers):[];

describe('pay difference over the payroll owner',()=>{
 it('reproduces the stored payslip figures exactly for the person\'s own released months, with the recorded salary change',async()=>{
  const {employee,mine,batches}=await people();
  const out=await explainOwnPayDifference(employee,{}) as unknown as Difference;
  expect(out.ok,JSON.stringify(out)).toBe(true);
  // October is generated but not released: the latest released month is September, compared with August.
  expect([out.period,out.previousPeriod]).toEqual(['2026-09','2026-08']);
  expect(out.comparisons).toHaveLength(1);
  const [comparison]=out.comparisons,[aug,sep]=[await stored(mine.employmentId,batches['2026-08']),await stored(mine.employmentId,batches['2026-09'])];
  const line=(key:string)=>comparison.lines.find(row=>row.key===key);
  // The rise is 5,500 − 5,000, as set on the employee's record.
  expect(line('basic')).toEqual({key:'basic',group:'earnings',current:5500,previous:5000,change:500});
  // Gross, deductions and net are the stored columns, subtracted (read straight off the payslip rows).
  const r2=(n:number)=>Math.round(n*100)/100;
  expect(comparison.totals.gross).toEqual({current:Number(sep.grossPay),previous:Number(aug.grossPay),change:r2(Number(sep.grossPay)-Number(aug.grossPay))});
  expect(comparison.totals.net).toEqual({current:Number(sep.netPay),previous:Number(aug.netPay),change:r2(Number(sep.netPay)-Number(aug.netPay))});
  const epf=(row:typeof aug)=>Number((row.statutory as {epfEmployee:number}).epfEmployee);
  expect(epf(sep)).toBeGreaterThan(epf(aug));
  expect(line('epf')).toMatchObject({current:epf(sep),previous:epf(aug),change:r2(epf(sep)-epf(aug))});
  expect(comparison.statutory.find(item=>item.key==='epf')).toMatchObject({ruleKind:'schedule'});
  expect(comparison.causes).toContainEqual({kind:'salary_change',current:5500,previous:5000,effectiveFrom:'2026-09-01'});
  // Only the person's own pay: the colleague's 7,300 appears nowhere.
  expect(numbers(out)).not.toContain(7300);expect(JSON.stringify(out)).not.toContain('Colleague');
  // The open month cannot be explained; the screen's own path agrees with the chat's.
  expect(await explainOwnPayDifference(employee,{period:'2026-10'})).toMatchObject({ok:false,refusal:'no_data',availablePeriods:['2026-09','2026-08']});
  expect(await explainOwnPayDifference(employee,{period:'2026-13'})).toMatchObject({ok:false,refusal:'invalid_input'});
  const screen=await ownPayDifference(employee,{companyId:base.companyId,period:'2026-09'});
  expect(screen.ok&&screen.comparisons[0].totals).toEqual(comparison.totals);
  expect(screen.ok&&screen.comparisons[0].lines).toEqual(comparison.lines);
 });
 it('answers an administrator from their own payslips only, never the people they administer',async()=>{
  const {hr}=await people();
  expect(await explainOwnPayDifference(hr,{})).toMatchObject({ok:false,refusal:'no_data'});
  expect(await ownPayDifference(hr,{companyId:base.companyId,period:'2026-09'})).toMatchObject({ok:false});
 });
 it('leaves the model only placeholders and gives the person the exact figure',async()=>{
  const {employee}=await people();
  const placeholder=(request:ModelRequest)=>(lastToolResult(request) as {comparisons:{lines:{key:string;change:string}[]}[]}).comparisons[0].lines.find(row=>row.key==='basic')!.change.split(' ')[0];
  const {result,model}=await turn(employee,'Why is my pay different from last month?',[{calls:[{name:'explain_pay_difference',args:{}}]},request=>({final:{reply:`Your basic salary went up by ${placeholder(request)}.`}})]);
  expect(result.trace.calls.map(call=>[call.tool,call.status])).toEqual([['explain_pay_difference','ok']]);
  const disclosure=result.trace.disclosure.find(row=>row.tool==='explain_pay_difference')!;
  expect(disclosure.undeclared).toEqual([]);expect(disclosure.removed).toEqual([]);expect(disclosure.banded.length).toBeGreaterThan(10);
  // What the model was sent holds no number at all, so it has nothing to do arithmetic on.
  const sent=lastToolResult(model.requests[1]);
  expect(numbers(sent)).toEqual([]);
  expect(result.reply).toBe('Your basic salary went up by 500.');
 });
 it('offers no explainer on a turn about another person',async()=>{
  const {employee}=await people();
  const {model}=await turn(employee,'Why is Fictional Why Colleague\'s pay different from last month?',[{final:{reply:'I can\'t look at another person\'s pay.',mode:'refuse'}}]);
  const offered=model.requests[0].tools.map(tool=>tool.name);
  for(const capability of TERAS_CAPABILITIES)expect(offered).not.toContain(capability.name);
 });
});

describe('claim limit over the claims owner',()=>{
 it('reproduces the limit, the person\'s own use and what is left, and the policy version',async()=>{
  const {employee,travel,uniq}=await people();
  const out=await explainOwnClaimLimit(employee,{claim_type:'travel '+uniq}) as unknown as {ok:true;claimType:string;employments:{annual:unknown;perClaimCap:number;policy:unknown;unlimited:boolean}[]};
  expect(out.ok,JSON.stringify(out)).toBe(true);expect(out.claimType).toBe('Travel '+uniq);expect(out.employments).toHaveLength(1);
  // 2,000 limit; 120 of the person's own, still pending; 2,000 − 120 left. The colleague's 450 is not theirs.
  expect(out.employments[0]).toMatchObject({unlimited:false,annual:{limit:2000,used:120,pending:120,remaining:1880},perClaimCap:500,
   policy:{validFrom:`${todayInKualaLumpur().slice(0,4)}-01-01`,gradeScoped:false}});
  expect(numbers(out)).not.toContain(450);
  expect(await explainOwnClaimLimit(employee,{claim_type:'Fictional Sabbatical'})).toMatchObject({ok:false,refusal:'no_data',claimTypes:['Travel '+uniq]});
  expect(travel.id).not.toBe('');
  const {result}=await turn(employee,'How much of my travel claim limit is left?',[{calls:[{name:'explain_claim_limit',args:{claim_type:'Travel '+uniq}}]},{final:{reply:'Here is what is left.'}}]);
  expect(result.trace.calls[0].status).toBe('ok');expect(result.trace.disclosure[0].undeclared).toEqual([]);
 });
});

describe('leave balance panel read',()=>{
 it('reproduces the leave dashboard card for the person\'s own leave type, and refuses another person\'s employment',async()=>{
  const {employee,mine,colleague}=await people();
  const out=await ownLeaveBalanceWhy(employee,{leaveTypeId:base.annualLeaveTypeId,locale:'en'});
  expect(out).not.toBeNull();
  const owned=projectMineLeaveEntitlement((await leaveEntitlementBreakdown(employee,mine.employmentId,base.annualLeaveTypeId,todayInKualaLumpur()))!);
  expect(out!.figures.entitlement).toBe(owned.displayEntitlementDays);
  expect(out!.figures.totalEntitlement).toBe(owned.totalEntitlement);
  expect(out!.proration?.annualEntitlementDays).toBe(14);
  await expect(ownLeaveBalanceWhy(employee,{leaveTypeId:base.annualLeaveTypeId,employmentId:colleague.employmentId})).rejects.toThrow();
  expect(await ownLeaveBalanceWhy(employee,{leaveTypeId:randomUUID()})).toBeNull();
 });
});
