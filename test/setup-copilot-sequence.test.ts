/** ADR-0170 step 4 — the setup co-pilot orders the readiness owners' own verdicts from an empty company to
 * the first payroll. Pure: fictional readiness results in, stages out; no database. */
import {describe,expect,it} from 'vitest';
import {CLAIMS_GAP,sequenceSetup,STAGE_PAGES} from '../core/setup-copilot/copilot';
import type {SetupReadiness} from '../core/product-context/setup-readiness';
import type {CoverageReadiness} from '../core/product-context/coverage-readiness';
import {SETUP_STAGES} from '../core/semantic-model/entities-setup';
import {DisclosureLedger,discloseToolOutput} from '../core/harness/disclosure';

const ALL={leave:true,attendance:true,lifecycle:true,claims:true,payroll:true};
type PayrollCheck=NonNullable<SetupReadiness['payroll']>['checks'][number];
const check=(key:string,status:'ok'|'warning'|'blocker',detail:Record<string,number>={},href='/admin/payroll-cycle')=>({key,status,detail,href}) as PayrollCheck;
const EMPTY:SetupReadiness={
 payroll:{payPeriod:'2026-11',ready:false,blockers:3,warnings:0,checks:[check('payrollItems','blocker',{activeComponents:0},'/admin/pay-components'),check('payrollCycle','blocker',{active:0}),
  check('masterData','blocker',{total:4,missingCompensation:3,missingStatutory:1},'/admin/personnel'),check('transactions','warning',{entered:0},'/payroll/transactions')]},
 records:{employees:4,ready:0,gaps:[{id:'no_compensation',blocks:'payroll',count:3},{id:'no_tax_number',blocks:'statutory_filing',count:4},{id:'no_bank_account',blocks:'payment',count:0}]},
 modules:{leave:{types:[{name:'Fictional Annual',status:'blocked',findings:['no_entitlement_table'],configuredDays:null},{name:'Fictional Medical',status:'ready',findings:[],configuredDays:{min:14,max:22}}],
   blocked:1,warning:0,ready:1,publicHolidays:[{country:'MY',year:2026,loaded:3,required:11}],pages:{balanceHealth:'/admin/leave-config/balance-health',holidays:'/admin/holidays'}},
  attendance:{scheduleGroups:0,hasDefaultGroup:false,currentEmployments:4,employmentsWithoutGroup:4,page:'/admin/attendance/schedule'},
  onboarding:{initialized:false,checklists:0,checklistsWithoutTasks:0,workflows:0,activeCatalogueItems:0,onboardingAccessHolders:0,page:'/admin/lifecycle/onboarding'}},
};
const COVERAGE:CoverageReadiness={entitlementCoverage:{activeEmployees:4,withoutTable:4,withoutJobGrade:4,page:'/admin/leave-config/entitlement-tables'},
 logins:{withoutLogin:4,withoutLoginWithEmployment:3,page:'/admin/users'},letters:{publicOrigin:true,notifications:false,email:false,page:'/letters/settings/policy'},
 leaveGeneration:{leaveYear:2026,runThisYear:false,latestRunYear:null,latestRunHadFailures:false,page:'/admin/leave-config/generate'}};
const READY:SetupReadiness={payroll:{payPeriod:'2026-11',ready:true,blockers:0,warnings:0,checks:[check('payrollItems','ok'),check('transactions','ok')]},records:{employees:4,ready:4,gaps:[]},
 modules:{leave:{...EMPTY.modules.leave!,types:[{name:'Fictional Annual',status:'ready',findings:[],configuredDays:{min:14,max:22}}],blocked:0,ready:1,publicHolidays:[{country:'MY',year:2026,loaded:13,required:11}]},
  attendance:{scheduleGroups:1,hasDefaultGroup:true,currentEmployments:4,employmentsWithoutGroup:0,page:'/admin/attendance/schedule'},
  onboarding:{initialized:true,checklists:1,checklistsWithoutTasks:0,workflows:1,activeCatalogueItems:3,onboardingAccessHolders:1,page:'/admin/lifecycle/onboarding'}}};
const DONE_COVERAGE:CoverageReadiness={entitlementCoverage:{activeEmployees:4,withoutTable:0,withoutJobGrade:0,page:'/admin/leave-config/entitlement-tables'},
 logins:{withoutLogin:0,withoutLoginWithEmployment:0,page:'/admin/users'},letters:{publicOrigin:true,notifications:true,email:true,page:'/letters/settings/policy'},
 leaveGeneration:{leaveYear:2026,runThisYear:true,latestRunYear:2026,latestRunHadFailures:false,page:'/admin/leave-config/generate'}};
const stage=(result:ReturnType<typeof sequenceSetup>,key:string)=>result.stages.find(row=>row.stage===key)!;

describe('setup co-pilot sequence',()=>{
 it('walks an empty company in order and points at the first blocked stage',()=>{
  const result=sequenceSetup(EMPTY,COVERAGE,ALL);
  expect(result.stages.map(row=>row.stage)).toEqual([...SETUP_STAGES]);
  expect(result.next).toEqual({stage:'company_payroll_setup',status:'blocked',page:'/admin/pay-components'});
  expect(stage(result,'company_payroll_setup').blockers.map(row=>row.check)).toEqual(['payrollItems','payrollCycle']);
  // Record gaps: pay and payment block, statutory numbers only warn; zero counts are not findings.
  expect(stage(result,'employee_records').blockers.map(row=>[row.check,row.severity,row.count])).toEqual([['masterData','blocker',4],['no_compensation','blocker',3],['no_tax_number','warning',4]]);
  expect(stage(result,'employee_logins')).toMatchObject({status:'attention',blockers:[{check:'employees_without_login',count:3,page:'/admin/users'}]});
  expect(stage(result,'leave_setup').blockers.map(row=>[row.check,row.subject])).toEqual([['no_entitlement_table','Fictional Annual'],['public_holidays_below_minimum','2026'],
   ['employees_without_entitlement_table',null],['employees_without_job_grade',null],['no_leave_generation_this_year','2026']]);
  expect(stage(result,'attendance_setup').status).toBe('blocked');expect(stage(result,'letters_setup').blockers.map(row=>row.check)).toEqual(['letters_notifications_off']);
  expect(stage(result,'claims_setup').status).toBe('no_owner');expect(result.gaps).toEqual([CLAIMS_GAP]);
  expect(stage(result,'first_payroll').blockers.map(row=>[row.check,row.subject])).toEqual([['transactions',null],['earlier_stage_not_ready','company_payroll_setup'],['earlier_stage_not_ready','employee_records']]);
  expect(result.complete).toBe(false);
 });
 it('reports a ready company as complete, with claims still a gap',()=>{
  const result=sequenceSetup(READY,DONE_COVERAGE,ALL);
  expect(result.stages.filter(row=>row.status!=='done').map(row=>[row.stage,row.status])).toEqual([['claims_setup','no_owner']]);
  expect(result.complete).toBe(true);expect(result.next).toBeNull();
  for(const row of result.stages)expect(row.page).toBe(STAGE_PAGES[row.stage]);
 });
 it('marks unused modules off and unreadable owners unknown, and never treats unknown as done',()=>{
  const result=sequenceSetup({payroll:null,records:null,modules:{leave:null,attendance:null,onboarding:null}},{...DONE_COVERAGE,logins:{refused:true},letters:null,entitlementCoverage:{refused:true}},
   {leave:true,attendance:false,lifecycle:false,claims:false,payroll:true});
  expect(Object.fromEntries(result.stages.map(row=>[row.stage,row.status]))).toEqual({company_payroll_setup:'unknown',employee_records:'unknown',employee_logins:'unknown',leave_setup:'unknown',
   attendance_setup:'off',onboarding_setup:'off',letters_setup:'off',claims_setup:'off',first_payroll:'unknown'});
  expect(result.next?.stage).toBe('company_payroll_setup');expect(result.complete).toBe(false);expect(result.gaps).toEqual([]);
 });
 it('discloses under its declaration: counts leave as bands, configuration names stay, nothing undeclared',()=>{
  const ledger=new DisclosureLedger('admin');
  const {value,applied}=discloseToolOutput('setup_copilot','setup_copilot',{ok:true,...sequenceSetup(EMPTY,COVERAGE,ALL),provenance:{owner:'core/setup-copilot/copilot.ts#setupCopilot',ruleVersionSource:'n/a',page:'/control-tower/readiness',note:'n/a'}},ledger);
  expect(applied.undeclared).toEqual([]);expect(applied.removed).toEqual([]);
  const text=JSON.stringify(value);expect(text).toContain('Fictional Annual');expect(text).not.toMatch(/"count":\d/);
  expect(applied.banded.every(path=>path.endsWith('.count'))).toBe(true);expect(applied.banded.length).toBeGreaterThan(5);
 });
});
