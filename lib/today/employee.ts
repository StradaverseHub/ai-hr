/** Employee Today (owner decision, 11 Nov 2026: the bento one-pager, EmployeeLight/EmployeeDashboard.dc.html): the
 * rules the panels follow, as pure functions.
 *
 * Nothing here reads, computes a balance, an amount or a pay date. Each panel reads its facts from their owners
 * (components/today/employee/reads.ts) and these functions only choose, order and arrange what those owners returned.
 * Every date is a calendar day, worked out through the HR date owner (lib/hr-date.ts).
 *
 * Employees never change their own record here: a step that changes their data is something they SEND (to HR, through
 * the change request flow of ADR-0159, or to their manager as an attendance request), and the owner decides it. */
import {addCalendarDays,calendarDaysBetween,isoWeekdayOf} from '../hr-date-calendar';
import type {PayrollItem,PayrollItemKind} from '../pre-salary/items';

// ── Audience ───────────────────────────────────────────────────────────────────────────────────────────────────
/** Roles other than administrator whose Today stays the personal layout with the dashboard under "More" (manager and
 * partner Today are a later step, owner decision 11 Nov 2026). */
const NOT_EMPLOYEE_ONLY:ReadonlySet<string>=new Set(['manager','payroll_partner','performance_partner','performance_comp_partner']);
/** Employee Today is drawn for an employee and nobody else: not an administrator (`admin`, the caller's own isAdmin
 * answer), not a manager and not a partner. Choosing a layout never widens a read. */
export function isEmployeeOnlyAudience(roles:readonly string[]|null|undefined,admin:boolean):boolean{
 return !admin&&!(roles??[]).some(role=>NOT_EMPLOYEE_ONLY.has(role));
}

// ── Next step and Then ─────────────────────────────────────────────────────────────────────────────────────────
/** A step's kind: a Before payroll checklist kind, or a passport the documents loop found expiring. */
export type StepKind=PayrollItemKind|'passport_renew';
/** Who decides once the person has sent it. `you`: nothing is sent, the person does it (acknowledge, attach). */
export type StepDecider='hr'|'manager'|'you';
export type NextStep=Readonly<{
 key:string;kind:StepKind;
 /** When it must be done by (the item's own deadline or the payroll cut-off), or null when no owner gave one. */
 due:string|null;
 /** The day the step is about (a clock day, a claim's date), or null. */
 date:string|null;endDate?:string|null;
 /** The person's own leave or claim type, as its owner names it. */
 label?:string|null;
 href:string;decider:StepDecider;
}>;

/** The details HR keeps on the person's record: the person sends them to HR, HR approves (ADR-0159). */
const SEND_TO_HR:ReadonlySet<StepKind>=new Set(['bank_missing','tax_number_missing','epf_number_missing','socso_number_missing','identity_missing','tp1_draft','passport_renew']);
/** Attendance days the person asks their manager to correct (a missed clock-out is a request the manager approves). */
const SEND_TO_MANAGER:ReadonlySet<StepKind>=new Set(['missed_clock_in','missed_clock_out','absent_no_leave']);
export const deciderOf=(kind:StepKind):StepDecider=>SEND_TO_HR.has(kind)?'hr':SEND_TO_MANAGER.has(kind)?'manager':'you';

/** What happens if the step is left undone, most serious first. Pay that cannot be paid correctly comes first, then
 * pay that may be deducted, then money the person may lose, then things that only stay open. */
export const CONSEQUENCE:Readonly<Record<StepKind,number>>=Object.freeze({
 bank_missing:0,tax_number_missing:0,epf_number_missing:0,socso_number_missing:0,identity_missing:0,
 absent_no_leave:1,missed_clock_out:1,missed_clock_in:1,
 claim_deadline:2,leave_certificate_missing:2,
 claim_receipt_missing:3,claim_draft:3,tp1_draft:3,
 passport_renew:4,
 letter_acknowledge:5,notice_acknowledge:5,review_acknowledge:5,onboarding_acknowledge:5,
 // Kinds that never become a step (waiting, check or an approval) still have a place, last.
 late_or_early:9,attendance_request_pending:9,overtime_pending:9,overtime_over_cap:9,leave_pending:9,leave_unpaid:9,claim_pending:9,toil_pending:9,
 details_request_pending:9,tp3_new_joiner:9,tp1_pending:9,dependants_mismatch:9,
 approve_leave:9,approve_leave_cancellation:9,approve_attendance:9,approve_claim:9,approve_toil:9,
});

const FAR='9999-12-31';
/** Soonest due first (no due date last); on the same day the more serious consequence; then the step's own day; then
 * its key. Deterministic whatever order the owners returned them in. */
export function orderNextSteps(steps:readonly NextStep[]):readonly NextStep[]{
 return Object.freeze([...steps].sort((a,b)=>(a.due??FAR).localeCompare(b.due??FAR)||CONSEQUENCE[a.kind]-CONSEQUENCE[b.kind]
  ||(a.date??FAR).localeCompare(b.date??FAR)||a.key.localeCompare(b.key)));
}

/** The person's own steps: the checklist items they must act on (`todo`; `check` and `waiting` items are not theirs to
 * do), and each passport the documents loop found expiring. Ordered by orderNextSteps. */
export function nextStepsFrom(items:readonly PayrollItem[],passports:readonly Readonly<{caseId:string;expiresOn:string;href:string}>[]=[]):readonly NextStep[]{
 const steps:NextStep[]=items.filter(item=>item.state==='todo'&&item.group!=='approvals').map(item=>Object.freeze({
  key:item.key,kind:item.kind,due:item.due,date:item.date,...(item.endDate!==undefined?{endDate:item.endDate}:{}),
  ...(item.label!==undefined?{label:item.label}:{}),href:item.action.href,decider:deciderOf(item.kind)}));
 for(const card of passports)steps.push(Object.freeze({key:`passport_renew:${card.caseId}`,kind:'passport_renew' as const,due:card.expiresOn,date:null,href:card.href,decider:'hr' as const}));
 return orderNextSteps(steps);
}

/** Nothing needs the person: every source was read and none had a step. A source that failed is never all clear. */
export const isAllClear=(p:Readonly<{steps:readonly NextStep[];failed:boolean}>)=>!p.failed&&p.steps.length===0;

// ── Panel visibility ───────────────────────────────────────────────────────────────────────────────────────────
/** A module for the person's own company: on, off (not in use), or failed (the entitlement could not be resolved:
 * an incident, never "not in use"). */
export type ModuleState='on'|'off'|'failed';
export type PanelVisibility='show'|'hide'|'unavailable';
/** A module's panel: shown when the module is in use, hidden entirely when it is not, and a "could not load" note when
 * the entitlement itself could not be read (so an outage never reads as a plan change). */
export const panelVisibility=(state:ModuleState):PanelVisibility=>state==='on'?'show':state==='off'?'hide':'unavailable';
export type EmployeePanels=Readonly<{payday:PanelVisibility;leave:PanelVisibility;hours:PanelVisibility}>;
/** Payday follows Payroll, the leave rings Leave, and This week's hours Attendance, each for the person's company. */
export const employeePanels=(modules:Readonly<{payroll:ModuleState;leave:ModuleState;attendance:ModuleState}>):EmployeePanels=>
 Object.freeze({payday:panelVisibility(modules.payroll),leave:panelVisibility(modules.leave),hours:panelVisibility(modules.attendance)});

// ── Payday ─────────────────────────────────────────────────────────────────────────────────────────────────────
export type PaydayView=Readonly<{kind:'payday'|'cutoff';date:string;daysAway:number}>;
/** The next recorded payday when payroll has one (a dated, generated run for the person: the payroll owner's own
 * answer); otherwise the payroll cut-off of the open pay period, which is the date the person can still act by. A date
 * already past is not shown. */
export function paydayView(today:string,nextPayment:string|null,cutOff:string|null):PaydayView|null{
 if(nextPayment&&nextPayment>=today)return Object.freeze({kind:'payday' as const,date:nextPayment,daysAway:calendarDaysBetween(today,nextPayment)});
 if(cutOff&&cutOff>=today)return Object.freeze({kind:'cutoff' as const,date:cutOff,daysAway:calendarDaysBetween(today,cutOff)});
 return null;
}

// ── This week's hours ──────────────────────────────────────────────────────────────────────────────────────────
/** Monday to Sunday of the week that holds `today`. */
export function weekOf(today:string):readonly string[]{
 const monday=addCalendarDays(today,1-isoWeekdayOf(today));
 return Object.freeze(Array.from({length:7},(_,i)=>addCalendarDays(monday,i)));
}
export type AttendanceDay=Readonly<{date:string;workedMinutes:number|null;scheduledMinutes:number|null;checkInAt:string|null;checkOutAt:string|null}>;
export type HoursBar=Readonly<{date:string;
 /** worked: a finished day the attendance owner counted; running: clocked in today, not yet out; none: a scheduled day
  * gone by with nothing recorded; upcoming: later this week. */
 state:'worked'|'running'|'none'|'upcoming';workedMinutes:number|null;scheduledMinutes:number|null}>;
export type WeekHours=Readonly<{bars:readonly HoursBar[];workedMinutes:number;shiftMinutes:number|null}>;
/** The week's bars from the attendance owner's own day rows. A weekend day with no shift and nothing worked is left
 * out. The total is the sum of the minutes the owner recorded; a day still running adds nothing until it is counted. */
export function weekHours(today:string,rows:readonly AttendanceDay[]):WeekHours{
 const byDate=new Map(rows.map(row=>[row.date,row]));
 const bars:HoursBar[]=[];
 for(const date of weekOf(today)){
  const row=byDate.get(date),worked=row?.workedMinutes??null,scheduled=row?.scheduledMinutes??null;
  if(isoWeekdayOf(date)>=6&&!scheduled&&!worked&&!row?.checkInAt)continue;
  const state:HoursBar['state']=date>today?'upcoming':worked!==null&&worked>0?'worked':date===today&&row?.checkInAt&&!row.checkOutAt?'running':'none';
  bars.push(Object.freeze({date,state,workedMinutes:worked,scheduledMinutes:scheduled}));
 }
 const shifts=bars.map(bar=>bar.scheduledMinutes).filter((value):value is number=>value!==null&&value>0);
 return Object.freeze({bars:Object.freeze(bars),workedMinutes:bars.reduce((sum,bar)=>sum+(bar.state==='worked'?bar.workedMinutes??0:0),0),
  shiftMinutes:shifts.length?Math.max(...shifts):null});
}

// ── Request tracker ────────────────────────────────────────────────────────────────────────────────────────────
export type TrackedKind='leave'|'claim'|'letter';
export type TrackedStage='waiting'|'preparing'|'approved'|'ready'|'declined';
export type TrackedRequest=Readonly<{key:string;kind:TrackedKind;label:string;stage:TrackedStage;
 /** The day it was sent. */sent:string;
 /** Leave: the dates asked for. */startDate?:string;endDate?:string;
 href:string}>;
export type TrackStep=Readonly<{step:'sent'|'decide'|'outcome';state:'done'|'current'|'todo'|'declined'}>;
/** Three steps for every request: sent, decided by its approver, then its outcome. */
export function trackSteps(stage:TrackedStage):readonly TrackStep[]{
 const decided=stage==='approved'||stage==='ready'||stage==='declined';
 return Object.freeze([
  Object.freeze({step:'sent' as const,state:'done' as const}),
  Object.freeze({step:'decide' as const,state:decided?'done' as const:'current' as const}),
  Object.freeze({step:'outcome' as const,state:stage==='declined'?'declined' as const:decided?'done' as const:'todo' as const}),
 ]);
}
const OPEN_STAGES:ReadonlySet<TrackedStage>=new Set(['waiting','preparing']);
/** Still open first, then the most recently sent; then the key. */
export function orderRequests(requests:readonly TrackedRequest[],limit=4):readonly TrackedRequest[]{
 return Object.freeze([...requests].sort((a,b)=>Number(OPEN_STAGES.has(b.stage))-Number(OPEN_STAGES.has(a.stage))||b.sent.localeCompare(a.sent)||a.key.localeCompare(b.key)).slice(0,limit));
}
/** Whole days a request has waited since it was sent (0 on the day). */
export const waitingDays=(today:string,sent:string)=>Math.max(0,calendarDaysBetween(sent,today));

// ── Coming up ──────────────────────────────────────────────────────────────────────────────────────────────────
export type ComingUpKind='payday'|'cutoff'|'leave'|'holiday'|'managerAway';
export type ComingUp=Readonly<{date:string;endDate:string;kind:ComingUpKind;name:string|null}>;
/** Runs of consecutive days, each as from–to. */
export function dayRuns(dates:readonly string[]):readonly Readonly<{from:string;to:string}>[]{
 const sorted=[...new Set(dates)].sort(),runs:{from:string;to:string}[]=[];
 for(const date of sorted){const last=runs[runs.length-1];if(last&&addCalendarDays(last.to,1)===date)last.to=date;else runs.push({from:date,to:date});}
 return Object.freeze(runs.map(run=>Object.freeze(run)));
}
const KIND_ORDER:Readonly<Record<ComingUpKind,number>>={cutoff:0,payday:1,leave:2,managerAway:3,holiday:4};
/** What is coming up from today on, soonest first (on the same day: cut-off, payday, the person's leave, a manager
 * away, a holiday), at most `limit`. Each fact is one its owner returned; nothing is inferred. */
export function comingUp(today:string,p:Readonly<{cutOff?:string|null;payday?:string|null;leaveDates?:readonly string[];
 holidays?:readonly Readonly<{date:string;name:string|null}>[];managerAway?:readonly Readonly<{from:string;to:string;name:string|null}>[]}>,limit=4):readonly ComingUp[]{
 const out:ComingUp[]=[];
 if(p.cutOff&&p.cutOff>=today)out.push({date:p.cutOff,endDate:p.cutOff,kind:'cutoff',name:null});
 if(p.payday&&p.payday>=today)out.push({date:p.payday,endDate:p.payday,kind:'payday',name:null});
 for(const run of dayRuns(p.leaveDates??[]))if(run.to>=today)out.push({date:run.from<today?today:run.from,endDate:run.to,kind:'leave',name:null});
 for(const away of p.managerAway??[])if(away.to>=today)out.push({date:away.from<today?today:away.from,endDate:away.to,kind:'managerAway',name:away.name});
 const seen=new Set<string>();
 for(const holiday of p.holidays??[]){const id=`${holiday.date}|${holiday.name??''}`;if(holiday.date>=today&&!seen.has(id)){seen.add(id);out.push({date:holiday.date,endDate:holiday.date,kind:'holiday',name:holiday.name});}}
 return Object.freeze(out.sort((a,b)=>a.date.localeCompare(b.date)||KIND_ORDER[a.kind]-KIND_ORDER[b.kind]||(a.name??'').localeCompare(b.name??'')||a.endDate.localeCompare(b.endDate))
  .slice(0,limit).map(item=>Object.freeze(item)));
}
