/** Employee Today's own-fact readers (owner decision, 11 Nov 2026), shared by the web one-pager
 * (components/today/employee/reads.ts memoises each for its render with React `cache`) and the native Today
 * (core/mobile-today.ts, one request). Every reader reads from the fact's existing owner as the person, for their own
 * selected employment; this module adds no rule of its own.
 *
 * AUTHORIZE FIRST. readOwnContext proves the own employment (core/employee-home.ts: the actual login, the own-subject
 * inventory and the dated company, in one read-only snapshot) before any panel reads; a panel only ever receives that
 * proven employment id, and each owner below repeats its own checks under row-level security.
 *
 * Every reader joins the request's shared read-only snapshot (lib/request-read-scope.ts): the web render's own scope,
 * or one the caller installs with withRequestReadScope. Nothing here writes, computes a balance, an amount or a date:
 * those are each owner's own answers. */
import {withSharedReadSnapshot,withTenant,type SessionContext} from '../db/client';
import {requestReadScope} from '../lib/request-read-scope';
import {EntitlementsResolutionFailedError,isModuleEnabled} from './entitlements';
import {readEmployeeHomeIdentityContextTx,readEmployeeHomePayHints} from './employee-home';
import {readMyPayrollReadiness} from './pre-salary/person-items';
import {readLoopCards} from './loops/cards';
import {readEmployeeHomeCalendar} from './employee-home-calendar';
import {readHomeTeamCalendar,readHomeTeamCalendarAndManagers} from './employee-home-sharing';
import {reportingLinesFor} from './read';
import {attendanceEmploymentRangePage} from '../packs/attendance/service';
import {parsePageQuery} from '../lib/pagination';
import {addCalendarDays} from '../lib/hr-date-calendar';
import {managerAbsences} from '../lib/today/coming-up';
import {weekOf,type ModuleState} from '../lib/today/employee';

/** One read inside the request's shared read-only snapshot, when a request scope is installed. */
export const sharedOwnRead=<T,>(s:SessionContext,read:()=>Promise<T>)=>withSharedReadSnapshot(s,read,undefined,requestReadScope());

/** A module for the person's own company, with the throwing check (test/module-catalog-drift.test.ts): an entitlement
 * snapshot that cannot be resolved is `failed`, never "not in use". */
export function moduleState(s:SessionContext,code:string,companyId:string|null):ModuleState{
 try{return isModuleEnabled(s,code,companyId)?'on':'off';}catch(error){if(error instanceof EntitlementsResolutionFailedError)return 'failed';throw error;}
}

/** The person's own selection, role and dated company (the Home identity owner). A foreign or stale selector throws
 * HomeAccessError('employmentUnavailable'); none or several unchosen employments are states, not errors. */
export const readOwnContext=(s:SessionContext,employmentId:string|undefined)=>
 sharedOwnRead(s,()=>withTenant(s,tx=>readEmployeeHomeIdentityContextTx(tx,s,employmentId),{readOnlySnapshot:true}));

/** The person's own Before payroll checklist (core/pre-salary/person-items.ts): items, due dates, the pay period and its
 * cut-off. Their approvals as an approver are not read here: decisions assigned to the person (a named participant, a
 * profile-change assignee, a reviewer, a rewards approver) are shown by the Waiting for your decision panel instead
 * (readWaitingForYou), which counts exactly what the Tasks page lists.
 * null: payroll is not in use. */
export const readOwnReadiness=(s:SessionContext,employmentId:string,locale:string,today:string)=>
 readMyPayrollReadiness(s,{employmentId,locale,today,includeApprovals:false});

/** The loops' open cards addressed to the person themself (core/loops/cards.ts employeeOnly): missed clock-outs,
 * gaps on their record and passports expiring. */
export const readOwnLoopCards=(s:SessionContext,today:string)=>
 sharedOwnRead(s,()=>readLoopCards(s,{scopeIds:[],admin:false,today,employeeOnly:true}));

/** The passports the documents loop found expiring for the person (their own open cases only). */
export const readOwnPassportCards=async(s:SessionContext,today:string)=>
 (await readOwnLoopCards(s,today)).flatMap(card=>card.kind==='passport'?[card]:[]);

/** The payroll owner's own metadata: the next recorded payment date and the latest released payslips. No amount. */
export const readOwnPayHints=(s:SessionContext,employmentId:string)=>sharedOwnRead(s,()=>readEmployeeHomePayHints(s,employmentId));

/** The person's own Home calendar for a month: their leave, holidays and recorded paydays (core/employee-home-calendar.ts). */
export const readOwnCalendar=(s:SessionContext,employmentId:string,month:string)=>sharedOwnRead(s,()=>readEmployeeHomeCalendar(s,employmentId,month));

/** The attendance owner's own day rows for Monday to Sunday of this week: worked and scheduled minutes. */
export const readOwnWeek=async(s:SessionContext,employmentId:string,today:string)=>{
 const week=weekOf(today);
 const page=await sharedOwnRead(s,()=>attendanceEmploymentRangePage(s,employmentId,week[0],week[6],parsePageQuery({page:'0',size:'25'})));
 return page.dayPage.map(row=>({date:row.date,workedMinutes:row.workedMinutes,scheduledMinutes:row.scheduledMinutes,checkInAt:row.checkInAt,checkOutAt:row.checkOutAt}));
};

/** The Home team calendar's look-ahead for Coming up: today and the next 13 days. */
export const COMING_UP_DAYS=14;
/** The person's managers away in the next COMING_UP_DAYS days, from the Home team calendar (its own sharing policy). */
export const readManagersAway=async(s:SessionContext,employmentId:string,today:string)=>{
 const to=addCalendarDays(today,COMING_UP_DAYS-1);
 const bundled=await sharedOwnRead(s,()=>readHomeTeamCalendarAndManagers(s,employmentId,today,to)).catch(()=>null);
 if(bundled)return managerAbsences(bundled.managerEmploymentIds,bundled.calendar.days);
 const [lines,calendar]=await sharedOwnRead(s,()=>Promise.all([reportingLinesFor(s,employmentId),readHomeTeamCalendar(s,employmentId,today,to)]));
 return managerAbsences(lines.managers.map(line=>line.employmentId),calendar.days);
};
