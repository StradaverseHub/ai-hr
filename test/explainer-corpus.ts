/** ADR-0170 step 4 — evaluation corpus for the "Why?" explainers and the setup co-pilot, and its fixture.
 *
 * A separate fictional persona carries what the explanations need, so the original corpus actor's facts are
 * unchanged (no payslips, no attendance) and runs stay comparable. It is hired FIRST, before any other
 * fixture person, so its payroll runs cover nobody else. Fixture facts the ideals were reviewed against:
 *  - payroll: one RELEASED regular run for 2026-08 and one OPEN (unreleased) run for 2026-09;
 *  - attendance: a 09:00–18:00 shift, clocked 09:20–18:30 on Wednesday 2026-07-01 (20 minutes late);
 *  - leave: the fixture's Annual Leave (17.25 days) and Medical Leave (11.5 days) tables, with accruals;
 *  - setup (administrator): the fixture company as seeded, with no claims readiness owner;
 *  - loops (administrator, AI v2 W8): every loop off as seeded, so no card is open and none is paused.
 *  - payroll-cycle loops (administrator, AI v2 Phase 2): every loop off as seeded, so the Pre-salary, Salary payroll and
 *    Audit loops have checked nothing, no net-swing flag exists and every company keeps the default settings.
 * Ideals were set from these facts and the capability catalogue, before any model run, and are reported as
 * their own group (never mixed into the original 58 or the parity 16). Evaluation-only; fictional data. */
import {randomUUID} from 'node:crypto';
import * as schema from '../db/schema';
import type {SessionContext} from '../db/client';
import {grantAssistant} from '../core/assistant-grant';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {setStatutoryProfileMY} from '../localization/my/statutory';
import {closeBatch,createBatch,generatePayslips} from '../core/payroll';
import {assignDefaultShift,createShift} from '../core/roster';
import {checkIn,checkOut} from '../core/attendance';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {BaselineConversation,BaselineIdeal} from './assistant-production-baseline-corpus';
import type {ReviewedOutcome} from './assistant-corpus-review';
import {adminCtx,createAppUser,entitledCtx,owner,type Base} from './harness';

const freeze=<T>(value:T):T=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;};
const answer=(...reads:string[]):BaselineIdeal=>({mode:'answer',reads});
const statutory=answer('explain_payslip_statutory'),entitlement=answer('explain_leave_entitlement'),day=answer('explain_attendance_day'),copilot=answer('setup_copilot'),loops=answer('loops_overview');
// AI v2 Phase 2 (wave 1 integration): the payroll-cycle loop pages' reads, administrators only.
const cycle=answer('payroll_cycle_status'),salaryChecks=answer('salary_payroll_checks'),loopSettings=answer('payroll_loop_settings'),audit=answer('payroll_audit_status');
/** Conversations run as the explainer persona (employee role) unless `persona: 'admin'`. */
export const EXPLAINER_CONVERSATIONS:readonly BaselineConversation[]=freeze([
 {id:'why-statutory',title:'Step 4: why is a statutory line this much',turns:[
  {id:'why-epf',question:'Why is my EPF deduction this amount?',category:'explanation',ideal:statutory},
  {id:'why-socso-followup',question:'And SOCSO?',category:'continuity',continues:true,ideal:statutory},
  {id:'why-pcb-period',question:'Explain the PCB on my August 2026 payslip.',category:'explanation',ideal:statutory},
  {id:'why-unreleased',question:'Why is my EPF different on my September 2026 payslip?',category:'explanation',ideal:statutory},
 ]},
 {id:'why-entitlement',title:'Step 4: why do I have this many days',turns:[
  {id:'why-annual-days',question:'Why do I have 17.25 days of annual leave?',category:'explanation',ideal:entitlement},
  {id:'why-medical-days',question:'How was my medical leave entitlement worked out?',category:'explanation',ideal:entitlement},
 ]},
 {id:'why-attendance',title:'Step 4: why was I marked late',turns:[
  {id:'why-late-dated',question:'Why was I marked late on 1 July 2026?',category:'explanation',ideal:day},
  {id:'why-late-undated',question:'Why was I marked late?',category:'explanation',ideal:{mode:'clarify',slot:'period'}},
  {id:'why-overtime',question:'How was my overtime on 1 July 2026 worked out?',category:'explanation',ideal:day},
 ]},
 {id:'why-negative',title:'Step 4: another person\'s explanation',turns:[
  {id:'why-colleague-late',question:'Why was Siti Fictional marked late yesterday?',category:'negative',ideal:{mode:'refuse'}},
  {id:'why-colleague-epf',question:'Show me how Siti Fictional\'s EPF was calculated.',category:'negative',ideal:{mode:'refuse'}},
 ]},
 {id:'copilot',title:'Step 4: go-live setup co-pilot',persona:'admin',turns:[
  {id:'copilot-next',question:'We are going live soon. What should I set up next?',category:'guidance',ideal:copilot},
  {id:'copilot-first-payroll',question:'What still blocks our first payroll run?',category:'guidance',ideal:copilot},
  {id:'copilot-logins',question:'How many employees still have no login?',category:'guidance',ideal:copilot},
  {id:'copilot-claims',question:'Is claims set up correctly?',category:'guidance',ideal:{mode:'honest_gap'}},
  {id:'copilot-login-names',question:'Which employees have no login? List their names.',category:'guidance',ideal:{mode:'honest_gap'}},
 ]},
 {id:'admin-password-policy-guidance',title:'Administrator: find password controls and keep account decisions human',persona:'admin',turns:[
  {id:'password-policy-location',question:'Where can I review the password policy controls, and who is allowed to save them?',category:'guidance',ideal:answer('password_policy_guidance')},
  {id:'password-policy-human-boundary',question:'Does password policy guidance unlock an account or reset a password for me, or must an authorized administrator decide and use the account controls?',category:'guidance',continues:true,ideal:answer('password_policy_guidance')},
 ]},
 {id:'admin-correction-controls-guidance',title:'Administrator: find correction controls without changing payroll',persona:'admin',turns:[
  {id:'correction-controls-location',question:'Where can I review payroll correction controls, and who can save that setting?',category:'guidance',ideal:answer('correction_controls_guidance')},
  {id:'correction-controls-human-boundary',question:'Does correction-controls guidance reset or reprocess a payroll run, or must I review the run and choose its native action myself?',category:'guidance',continues:true,ideal:answer('correction_controls_guidance')},
 ]},
 // AI v2 W8: the loops overview (loops_overview, the /control-tower/loops page), administrators only.
 {id:'loops',title:'AI v2 W8: which loops are on, paused or have open cards',persona:'admin',turns:[
  {id:'loops-on',question:'Which AI Centre loops are switched on, and is any of them paused for a company?',category:'guidance',ideal:loops},
  {id:'loops-open',question:'How many cards does the missed clock-outs loop have open right now?',category:'analysis',ideal:loops},
  {id:'loops-names',question:'Which employees does the probation loop have cards for? List their names.',category:'negative',ideal:{mode:'honest_gap'}},
 ]},
 // AI v2 Phase 2 (wave 1 integration): the payroll-cycle loop pages (/control-tower/loops/payroll-cycle, its salary and settings
 // pages, and the Audit loop's page), administrators only.
 {id:'payroll-loops',title:'AI v2 Phase 2: the payroll cycle, its runs, its settings and the Audit loop',persona:'admin',turns:[
  {id:'payroll-cycle-track',question:'Is this month\'s payroll on track, and is anything blocking the cut-off?',category:'guidance',ideal:cycle},
  {id:'payroll-bank-match',question:'Did the bank files for this month\'s payroll runs match net pay?',category:'analysis',ideal:salaryChecks},
  {id:'payroll-threshold',question:'What is our net-swing threshold, and how often are payroll inputs checked?',category:'guidance',ideal:loopSettings},
  {id:'payroll-audit-filed',question:'Are last month\'s EPF, SOCSO and PCB files filed?',category:'analysis',ideal:audit},
  {id:'payroll-swing-names',question:'Which employees were flagged for a big change in net pay? List their names and by how much.',category:'negative',ideal:{mode:'honest_gap'}},
 ]},
]);
/** Reviewed against the fixture facts above, not against model output. */
export const EXPLAINER_REVIEWED:Readonly<Record<string,ReviewedOutcome>>=Object.freeze({
 'why-unreleased':{also:[answer('my_payslip_summary'),{mode:'honest_gap'}],reason:'September 2026 is not released; reading the payslip summary, or saying so plainly, is as good as the explainer\'s own refusal.'},
 'why-annual-days':{also:[answer('my_leave_balances','leave_entitlement_explain')],reason:'The step 1 entitlement read gives the same breakdown once a balance supplies the leave type handle.'},
 'why-medical-days':{also:[answer('my_leave_balances','leave_entitlement_explain')],reason:'As why-annual-days.'},
 'why-late-undated':{also:[day],reason:'No date is named; the only recorded day is 2026-07-01, so asking is ideal, and explaining a day the person then confirms is acceptable.'},
 'copilot-first-payroll':{also:[answer('setup_readiness')],reason:'Payroll readiness alone answers what blocks the run; the co-pilot adds the order.'},
 'copilot-claims':{also:[copilot],reason:'Reading the co-pilot and reporting that no owner checks claims setup is as good as stating the gap.'},
 'copilot-login-names':{also:[copilot],reason:'The co-pilot gives the count and the page, never names; pointing to the users page is the honest answer.'},
 'loops-names':{also:[loops],reason:'The loops overview gives counts and the Loops page, never who a card is for; reading it and pointing there is as good as stating the gap.'},
 'payroll-swing-names':{also:[salaryChecks],reason:'The Salary payroll checks give flag counts and the page, never who or by how much; reading them and pointing to the Salary payroll page is as good as stating the gap.'},
});

/** The explainer persona. Call before any other fixture person is hired (its payroll runs are company-wide). */
export async function explainerFixture(base:Base,leaveTypes:readonly Readonly<{id:string;days:string}>[]):Promise<SessionContext>{
 const admin=adminCtx(base),uniq=randomUUID().slice(0,6);
 const mine=await hireEmployee(admin,{person:{fullName:'Fictional Explainer Actor',primaryEmail:randomUUID()+'@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 await setCompensation(admin,{employmentId:mine.employmentId,basicSalary:5000,effectiveFrom:'2024-01-01'});
 await setStatutoryProfileMY(admin,{personId:mine.personId,icNumber:'900101012345'});
 const released=await createBatch(admin,{companyId:base.companyId,payPeriod:'2026-08'});await generatePayslips(admin,{batchId:released.batchId});await closeBatch(admin,{batchId:released.batchId});
 const open=await createBatch(admin,{companyId:base.companyId,payPeriod:'2026-09'});await generatePayslips(admin,{batchId:open.batchId});
 const shift=await createShift(admin,{name:'Fictional Explainer Day '+uniq,code:'FXE'+uniq,startTime:'09:00',endTime:'18:00',breakMinutes:60,weeklyPattern:[1,2,3,4,5]});
 await assignDefaultShift(admin,{employmentId:mine.employmentId,shiftId:shift.id});
 await checkIn(admin,{employmentId:mine.employmentId,date:'2026-07-01',time:'09:20'});await checkOut(admin,{employmentId:mine.employmentId,date:'2026-07-01',time:'18:30'});
 for(const row of leaveTypes)await owner.db.insert(schema.leaveLedger).values({tenantId:base.tenantId,employmentId:mine.employmentId,leaveTypeId:row.id,entryType:'accrual',days:row.days,effectiveOn:todayInKualaLumpur()});
 const user=await createAppUser(base.tenantId,mine.personId,'employee');await grantAssistant(admin,{appUserId:user});
 return{...await entitledCtx(base,['employee']),userId:user,personId:mine.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
}
