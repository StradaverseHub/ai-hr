/** ADR-0170 step 4 — the go-live setup co-pilot: from an empty company to its first payroll.
 *
 * Deterministic ordering over the readiness owners; it judges nothing they do not already judge:
 *  - payroll configuration and transactions: core/payroll-readiness.ts (through setup readiness);
 *  - employee record gaps: core/record-readiness.ts (through setup readiness);
 *  - leave types, public holidays, schedule groups, onboarding: ./module-readiness (through setup readiness);
 *  - entitlement coverage, logins pending, letter settings, leave generation: coverage-readiness.ts.
 * A stage is `off` when its module is not used, `unknown` when its owner could not be read for this caller,
 * `blocked` when a check blocks it, `attention` when only warnings remain, and `done` otherwise. Claims setup
 * has no readiness owner yet, so it is always `no_owner` and listed as a gap (ADR-0170 §3.6: that owner
 * belongs in the claims pack, not here). The first payroll is blocked while an earlier payroll-critical
 * stage is. Output: stage keys, check keys, configuration names, counts and pages; never a person.
 * Administrators only. Not imported by the production Assistant. */
import type {SessionContext} from '../../db/client';
import {isAdmin} from '../../lib/authz-model';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {isModuleEnabled} from '../entitlements';
import type {ReadinessCheckKey} from '../../packs/payroll/service';
import {setupReadiness,type SetupReadiness} from '../product-context/setup-readiness';
import {coverageReadiness,type CoverageReadiness,type Refused} from '../product-context/coverage-readiness';
import {SETUP_STAGES,type SetupStage,type SetupStatus} from '../semantic-model/entities-setup';

export type SetupBlocker=Readonly<{check:string;severity:'blocker'|'warning';subject:string|null;count:number|null;page:string}>;
export type SetupStageState=Readonly<{stage:SetupStage;status:SetupStatus;page:string;blockers:readonly SetupBlocker[]}>;
export type SetupCopilot=Readonly<{payPeriod:string|null;complete:boolean;next:Readonly<{stage:SetupStage;status:SetupStatus;page:string}>|null;
 stages:readonly SetupStageState[];gaps:readonly Readonly<{area:string;note:string}>[]}>;
export class SetupCopilotRefused extends Error{constructor(){super('The setup co-pilot is available to administrators only.');this.name='SetupCopilotRefused';}}

export const STAGE_PAGES:Readonly<Record<SetupStage,string>>=Object.freeze({company_payroll_setup:'/payroll/setup',employee_records:'/admin/personnel',employee_logins:'/admin/users',
 leave_setup:'/admin/leave-config/balance-health',attendance_setup:'/admin/attendance/schedule',onboarding_setup:'/admin/lifecycle/onboarding',letters_setup:'/letters/settings/policy',
 claims_setup:'/admin/claims',first_payroll:'/payroll/process'});
const PAYROLL_STAGE:Readonly<Record<ReadinessCheckKey,SetupStage>>={payrollItems:'company_payroll_setup',statutoryConfig:'company_payroll_setup',payrollCycle:'company_payroll_setup',
 defaultCycle:'company_payroll_setup',payrollSchedule:'company_payroll_setup',payrollPolicy:'company_payroll_setup',masterData:'employee_records',payModes:'employee_records',transactions:'first_payroll'};
/** The payroll checks that count records; the others are configuration flags with no count. */
const payrollCount=(key:ReadinessCheckKey,detail:Readonly<Record<string,number>>):number|null=>
 key==='masterData'?(detail.missingCompensation??0)+(detail.missingStatutory??0):key==='payModes'?detail.unpayable??null:null;
/** Payroll-critical stages: the first payroll waits for them. */
const BEFORE_PAYROLL:readonly SetupStage[]=['company_payroll_setup','employee_records'];
export const CLAIMS_GAP=Object.freeze({area:'claims_setup',note:'No readiness owner checks claims setup (claim types, limits, approvers) yet; check it on the claims settings page.'});

const blocker=(check:string,severity:SetupBlocker['severity'],page:string,count:number|null=null,subject:string|null=null):SetupBlocker=>Object.freeze({check,severity,subject,count,page});
const isRefused=(value:unknown):value is Refused=>!!value&&typeof value==='object'&&(value as Refused).refused===true;

/** Pure: orders the readiness owners' results into stages. `modules` says which optional modules are used. */
export function sequenceSetup(readiness:SetupReadiness,coverage:CoverageReadiness,modules:Readonly<{leave:boolean;attendance:boolean;lifecycle:boolean;claims:boolean;payroll:boolean}>):SetupCopilot{
 const found=new Map<SetupStage,SetupBlocker[]>(SETUP_STAGES.map(stage=>[stage,[]]));
 const unknown=new Set<SetupStage>(),off=new Set<SetupStage>();
 const add=(stage:SetupStage,row:SetupBlocker)=>found.get(stage)!.push(row);
 // Payroll configuration, record gaps and transactions.
 if(!modules.payroll){off.add('company_payroll_setup');off.add('first_payroll');}
 else if(!readiness.payroll){unknown.add('company_payroll_setup');unknown.add('first_payroll');}
 else for(const check of readiness.payroll.checks)if(check.status!=='ok')add(PAYROLL_STAGE[check.key],blocker(check.key,check.status==='blocker'?'blocker':'warning',check.href,payrollCount(check.key,check.detail)));
 if(!readiness.records)unknown.add('employee_records');
 // Pay and payment gaps stop a correct run; statutory-number gaps stop the filings after it.
 else for(const gap of readiness.records.gaps)if(gap.count>0)add('employee_records',blocker(gap.id,gap.blocks==='statutory_filing'?'warning':'blocker',STAGE_PAGES.employee_records,gap.count));
 if(isRefused(coverage.logins))unknown.add('employee_logins');
 else if(coverage.logins.withoutLoginWithEmployment>0)add('employee_logins',blocker('employees_without_login','warning',coverage.logins.page,coverage.logins.withoutLoginWithEmployment));
 // Leave: type health, public holidays, entitlement coverage and generation for this leave year.
 if(!modules.leave)off.add('leave_setup');
 else{
  const leave=readiness.modules.leave;
  if(!leave)unknown.add('leave_setup');
  else{
   for(const type of leave.types)if(type.status!=='ready')for(const finding of type.findings.length?type.findings:['leave_type_'+type.status])
    add('leave_setup',blocker(finding,type.status==='blocked'?'blocker':'warning',leave.pages.balanceHealth,null,type.name));
   for(const year of leave.publicHolidays)if(year.loaded<year.required)add('leave_setup',blocker('public_holidays_below_minimum','blocker',leave.pages.holidays,year.required-year.loaded,String(year.year)));
  }
  const coverageRow=coverage.entitlementCoverage;
  if(isRefused(coverageRow))unknown.add('leave_setup');
  else if(coverageRow&&coverageRow.withoutTable>0){add('leave_setup',blocker('employees_without_entitlement_table','warning',coverageRow.page,coverageRow.withoutTable));
   if(coverageRow.withoutJobGrade>0)add('leave_setup',blocker('employees_without_job_grade','warning',coverageRow.page,coverageRow.withoutJobGrade));}
  const generation=coverage.leaveGeneration;
  if(isRefused(generation))unknown.add('leave_setup');
  else if(generation){if(!generation.runThisYear)add('leave_setup',blocker('no_leave_generation_this_year','warning',generation.page,null,String(generation.leaveYear)));
   if(generation.latestRunHadFailures)add('leave_setup',blocker('latest_leave_generation_had_failures','warning',generation.page,null,generation.latestRunYear===null?null:String(generation.latestRunYear)));}
 }
 if(!modules.attendance)off.add('attendance_setup');
 else{const row=readiness.modules.attendance;
  if(!row)unknown.add('attendance_setup');
  else{if(row.scheduleGroups===0)add('attendance_setup',blocker('no_schedule_group','blocker',row.page));
   else if(!row.hasDefaultGroup)add('attendance_setup',blocker('no_default_schedule_group','warning',row.page));
   if(row.employmentsWithoutGroup>0)add('attendance_setup',blocker('employees_without_schedule_group','warning',row.page,row.employmentsWithoutGroup));}}
 if(!modules.lifecycle)off.add('onboarding_setup');
 else{const row=readiness.modules.onboarding;
  if(!row)unknown.add('onboarding_setup');
  else{if(!row.initialized)add('onboarding_setup',blocker('onboarding_not_initialised','warning',row.page));
   if(row.checklistsWithoutTasks>0)add('onboarding_setup',blocker('checklists_without_tasks','warning',row.page,row.checklistsWithoutTasks));
   if(row.onboardingAccessHolders===0)add('onboarding_setup',blocker('no_onboarding_access_holder','warning',row.page));}}
 const letters=coverage.letters;
 if(letters===null)off.add('letters_setup');
 else if(isRefused(letters))unknown.add('letters_setup');
 else{if(!letters.publicOrigin)add('letters_setup',blocker('letters_public_address_missing','warning',letters.page));
  if(!letters.notifications)add('letters_setup',blocker('letters_notifications_off','warning',letters.page));
  else if(!letters.email)add('letters_setup',blocker('letters_email_not_ready','warning',letters.page));}
 if(!modules.claims)off.add('claims_setup');
 const statusOf=(stage:SetupStage):SetupStatus=>{
  if(off.has(stage))return 'off';if(stage==='claims_setup')return 'no_owner';if(unknown.has(stage))return 'unknown';
  const rows=found.get(stage)!;return rows.some(row=>row.severity==='blocker')?'blocked':rows.length?'attention':'done';
 };
 // The first payroll waits for every payroll-critical stage before it.
 if(modules.payroll)for(const stage of BEFORE_PAYROLL)if(['blocked','unknown'].includes(statusOf(stage)))add('first_payroll',blocker('earlier_stage_not_ready','blocker',STAGE_PAGES[stage],null,stage));
 const stages=SETUP_STAGES.map(stage=>Object.freeze({stage,status:statusOf(stage),page:found.get(stage)!.find(row=>row.severity==='blocker')?.page??found.get(stage)![0]?.page??STAGE_PAGES[stage],blockers:Object.freeze(found.get(stage)!)}));
 const open=stages.find(row=>row.status==='blocked'||row.status==='unknown')??stages.find(row=>row.status==='attention');
 return Object.freeze({payPeriod:readiness.payroll?.payPeriod??null,complete:stages.every(row=>['done','off','no_owner'].includes(row.status)),
  next:open?Object.freeze({stage:open.stage,status:open.status,page:open.page}):null,stages:Object.freeze(stages),gaps:Object.freeze(modules.claims?[CLAIMS_GAP]:[])});
}

/** Reads the owners as the caller for `companyId`, then sequences them. */
export async function setupCopilot(ctx:SessionContext,companyId:string,today=todayInKualaLumpur()):Promise<SetupCopilot>{
 if(!isAdmin(ctx))throw new SetupCopilotRefused();
 const [readiness,coverage]=await Promise.all([setupReadiness(ctx,companyId),coverageReadiness(ctx,companyId,today)]);
 return sequenceSetup(readiness,coverage,{leave:isModuleEnabled(ctx,'leave'),attendance:isModuleEnabled(ctx,'attendance'),lifecycle:isModuleEnabled(ctx,'lifecycle'),
  claims:isModuleEnabled(ctx,'claims'),payroll:isModuleEnabled(ctx,'payroll')});
}
