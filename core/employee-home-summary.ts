/** Rendered, deterministic sentences over canonical owners. No salary, reason, peer record or model
 * context is transported. A failed owner fails this section; it never supplies a false calm state. */
import {withTenant,type SessionContext} from '../db/client';
import {requireOwnHomeSubject} from './employee-home';
import {readOwnEmployeeHomeConfiguration} from './employee-home-configuration';
import {readEmployeeHomeTasks} from './employee-home-tasks';
import {isModuleEnabled} from './entitlements';
import {listEligibleLeaveTypesFor} from './read';
import {nextApprovedLeavePresenceTx} from '../packs/leave/service';
import {readOwnPayrollHomeMetadata} from '../packs/payroll/service';
import {ownClaimFormAvailable} from '../packs/claims/service';
import {readProfilePresentationPolicy} from './profile-edit-policy';
import {originalHolidayCalendarFor} from './holidays';
import {replacementHolidayCalendarProjectionsTx} from './holiday-replacement-read';
import {todayInKualaLumpur} from '../lib/hr-date';
import {homeSummaryCandidates,renderHomeTemplate,type HomeSummaryCandidate,type HomeQuickAction} from '../lib/employee-home';
import type {EmployeeHomeSummary,HomeActionRefusal} from '../lib/employee-home-summary';
import type {Locale} from '../i18n/config';

/** Seven civil business dates ahead is a presentation window, not an eligibility or payroll rule. */
export const HOME_SUMMARY_LOOKAHEAD_DAYS=7;
export async function readEmployeeHomeSummary(ctx:SessionContext,employmentId:string,locale:Locale,replacementHolidayName:string):Promise<EmployeeHomeSummary>{
 const subject=await requireOwnHomeSubject(ctx,employmentId);
 // Also establishes current active own employment and the actual selected-company/role config.
 const {configuration}=await readOwnEmployeeHomeConfiguration(ctx,subject.employmentId);
 const now=new Date(),today=todayInKualaLumpur(now),through=new Date(Date.parse(today+'T00:00:00Z')+HOME_SUMMARY_LOOKAHEAD_DAYS*86400000).toISOString().slice(0,10);
 const leaveOn=isModuleEnabled(ctx,'leave'),payrollOn=isModuleEnabled(ctx,'payroll'),claimsOn=isModuleEnabled(ctx,'claims');
 const configured=new Set(configuration.quickActions);
 const [tasks,leave,holidays,replacements,payroll,leaveTypes,claimAvailable,profile]=await Promise.all([
  readEmployeeHomeTasks(ctx,subject.employmentId),
  leaveOn?withTenant(ctx,tx=>nextApprovedLeavePresenceTx(tx,subject.employmentId,today)):Promise.resolve(null),
  withTenant(ctx,tx=>originalHolidayCalendarFor(tx,{employmentId:subject.employmentId,startDate:today,endDate:through})),
  withTenant(ctx,tx=>replacementHolidayCalendarProjectionsTx(tx,{employmentIds:[subject.employmentId],startDate:today,endDate:through})),
  payrollOn?readOwnPayrollHomeMetadata(ctx,subject.employmentId):Promise.resolve(null),
  leaveOn&&configured.has('leave')?listEligibleLeaveTypesFor(ctx,subject.employmentId,locale):Promise.resolve([]),
  claimsOn&&configured.has('claim')?ownClaimFormAvailable(ctx,subject.employmentId):Promise.resolve(false),
  configured.has('profile')?readProfilePresentationPolicy(ctx):Promise.resolve(null),
 ]);
 const date=(day:string)=>new Intl.DateTimeFormat(locale,{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(day+'T00:00:00Z'));
 const candidates:HomeSummaryCandidate[]=[];
 // Actionable work precedes informational reminders. This is presentation ranking, not an invented
 // due date or overdue assertion; the task owner alone supplies those facts in Waiting for You.
 if(tasks.total>0)candidates.push({key:'tasks',templateKey:'tasksPending',importance:'urgent',destination:'tasks',values:{count:tasks.total}});
 if(leave&&leave.date<=through)candidates.push({key:'leave:'+leave.requestId,templateKey:'leaveApproved',importance:'goodNews',destination:'leave',values:{dates:date(leave.date)}});
 const holiday=[...holidays.filter(row=>!row.tentative&&row.active).map(row=>({key:'holiday:'+row.id,date:row.date,name:row.name})),
  ...replacements.map(row=>({key:'replacement:'+row.id,date:row.replacementDate,name:replacementHolidayName}))]
  .sort((a,b)=>a.date.localeCompare(b.date)||a.key.localeCompare(b.key))[0];
 if(holiday)candidates.push({key:holiday.key,templateKey:'holidayComing',importance:'reminder',destination:'calendar',values:{name:holiday.name,date:date(holiday.date)}});
 if(payroll?.nextPayment&&payroll.nextPayment.date<=through)candidates.push({key:'payday',templateKey:'paydayComing',importance:'reminder',destination:'calendar',values:{date:date(payroll.nextPayment.date)}});
 // "Ready" means currently published, never a guess about unread/new or a bank payment. The payroll
 // owner refuses scheduled/unclosed slips and exposes no amount. No newness timestamp is invented.
 const slip=payroll?.payslips[0];
 if(slip)candidates.push({key:'payslip:'+slip.id,templateKey:'payslipReady',importance:'goodNews',destination:'payslip',values:{period:slip.period}});
 const templates=new Map(configuration.templates.map(row=>[row.key,row]));
 const calm=templates.get('calm');
 const reasons:Record<HomeQuickAction,HomeActionRefusal|null>={
  leave:!leaveOn?'moduleUnavailable':!leaveTypes.length?'notConfigured':null,
  claim:!claimsOn?'moduleUnavailable':!claimAvailable?'notConfigured':null,
  payslip:!payrollOn?'moduleUnavailable':!slip?'noPayslip':null,
  profile:profile&&profile.editable.size>0?null:'detailsLocked',calendar:null,notices:null,
 };
 return {version:1,employmentId:subject.employmentId,serverNow:now.toISOString(),
  items:homeSummaryCandidates(candidates,configuration.templates).map(row=>({key:row.key,destination:row.destination,message:renderHomeTemplate(templates.get(row.templateKey)!,locale,row.values)})),
  // Disabled positive templates do not establish an empty day; never satisfy a sentence quota with
  // an invented fact. All underlying reads must have succeeded to reach this branch.
  calm:candidates.length===0&&calm?.enabled?renderHomeTemplate(calm,locale,{}):null,
  quickActions:configuration.quickActions.map(key=>({key,reason:reasons[key]}))};
}
