/** Employee Today (owner decision, 11 Nov 2026): every fact the one-pager shows, read from its existing owner as the
 * person, for their own selected employment.
 *
 * AUTHORIZE FIRST. readOwnContext proves the own employment (core/employee-home.ts: the actual login, the own-subject
 * inventory and the dated company, in one read-only snapshot) before any panel reads; a panel only ever receives that
 * proven employment id, and each owner below repeats its own checks under row-level security.
 *
 * ONE BOUNDED READ PER PANEL. Each reader is memoised for the render (React cache), so a fact two panels show (the
 * Before payroll checklist's due dates and cut-off, the month's Home calendar) is read once. Every reader joins the
 * render's shared read-only snapshot (lib/request-read-scope.ts). The request tracker fans out to three owners and so
 * runs under withBackgroundReadWork (docs/architecture/FUTURE-BUILD-CONTRACT.md). Nothing here writes, computes a
 * balance, an amount or a date: those are each owner's own answers. */
import {cache} from 'react';
import {withBackgroundReadWork,withSharedReadSnapshot,withTenant,type SessionContext} from '@/db/client';
import {requestReadScope} from '@/lib/request-read-scope';
import {EntitlementsResolutionFailedError,isModuleEnabled} from '@/core/entitlements';
import {readEmployeeHomeIdentityContextTx,readEmployeeHomePayHints} from '@/core/employee-home';
import {readMyPayrollReadiness} from '@/core/pre-salary/person-items';
import {readLoopCards} from '@/core/loops/cards';
import {readEmployeeHomeTimeOff} from '@/core/employee-home-time-off';
import {readEmployeeHomeCalendar} from '@/core/employee-home-calendar';
import {readEmployeeHomeNotices} from '@/core/employee-home-notices';
import {readHomeTeamCalendar,readHomeTeamCalendarAndManagers} from '@/core/employee-home-sharing';
import {listLeaveRequestsPage,reportingLinesFor} from '@/core/read';
import {listOpenClaimsForEmployment} from '@/packs/claims/service';
import {attendanceEmploymentRangePage} from '@/packs/attendance/service';
import {listMyLetterRequests} from '@/core/letter-requests';
import {mayUseAssistant} from '@/core/assistant-grant';
import {pendingTaskSummary} from '@/core/approvals-inbox';
import {parsePageQuery} from '@/lib/pagination';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {addCalendarDays} from '@/lib/hr-date-calendar';
import {managerAbsences} from '@/lib/today/coming-up';
import {weekOf,type ModuleState,type TrackedRequest} from '@/lib/today/employee';

const shared=<T,>(s:SessionContext,read:()=>Promise<T>)=>withSharedReadSnapshot(s,read,undefined,requestReadScope());

/** A module for the person's own company, with the throwing check (test/module-catalog-drift.test.ts): an entitlement
 * snapshot that cannot be resolved is `failed`, never "not in use". */
export function moduleState(s:SessionContext,code:string,companyId:string|null):ModuleState{
 try{return isModuleEnabled(s,code,companyId)?'on':'off';}catch(error){if(error instanceof EntitlementsResolutionFailedError)return 'failed';throw error;}
}

/** The person's own selection, role and dated company (the Home identity owner). A foreign or stale selector throws
 * HomeAccessError('employmentUnavailable'); none or several unchosen employments are states, not errors. */
export const readOwnContext=cache((s:SessionContext,employmentId:string|undefined)=>
 shared(s,()=>withTenant(s,tx=>readEmployeeHomeIdentityContextTx(tx,s,employmentId),{readOnlySnapshot:true})));

/** The person's own Before payroll checklist (core/pre-salary/person-items.ts): items, due dates, the pay period and its
 * cut-off. Their approvals as an approver are not read here: decisions assigned to the person (a named participant, a
 * profile-change assignee, a reviewer, a rewards approver) are shown by the Waiting for your decision panel instead
 * (readWaitingForYou), which counts exactly what the Tasks page lists.
 * null: payroll is not in use. */
export const readOwnReadiness=cache((s:SessionContext,employmentId:string,locale:string,today:string)=>
 readMyPayrollReadiness(s,{employmentId,locale,today,includeApprovals:false}));

/** The passports the documents loop found expiring for the person (their own open cases only). */
export const readOwnPassportCards=cache(async(s:SessionContext,today:string)=>
 (await shared(s,()=>readLoopCards(s,{scopeIds:[],admin:false,today,employeeOnly:true})))
  .flatMap(card=>card.kind==='passport'?[card]:[]));

/** The payroll owner's own metadata: the next recorded payment date and the latest released payslips. No amount. */
export const readOwnPayHints=cache((s:SessionContext,employmentId:string)=>shared(s,()=>readEmployeeHomePayHints(s,employmentId)));

/** The leave service's own figures for the person (core/employee-home-time-off.ts). */
export const readOwnTimeOff=cache((s:SessionContext,employmentId:string,locale:string)=>shared(s,()=>readEmployeeHomeTimeOff(s,employmentId,locale)));

/** The person's own Home calendar for a month: their leave, holidays and recorded paydays (core/employee-home-calendar.ts). */
export const readOwnCalendar=cache((s:SessionContext,employmentId:string,month:string)=>shared(s,()=>readEmployeeHomeCalendar(s,employmentId,month)));

/** The attendance owner's own day rows for Monday to Sunday of this week: worked and scheduled minutes. */
export const readOwnWeek=cache(async(s:SessionContext,employmentId:string,today:string)=>{
 const week=weekOf(today);
 const page=await shared(s,()=>attendanceEmploymentRangePage(s,employmentId,week[0],week[6],parsePageQuery({page:'0',size:'25'})));
 return page.dayPage.map(row=>({date:row.date,workedMinutes:row.workedMinutes,scheduledMinutes:row.scheduledMinutes,checkInAt:row.checkInAt,checkOutAt:row.checkOutAt}));
});

/** The Home team calendar's look-ahead for Coming up: today and the next 13 days. */
export const COMING_UP_DAYS=14;
/** The person's managers away in the next COMING_UP_DAYS days, from the Home team calendar (its own sharing policy). */
export const readManagersAway=cache(async(s:SessionContext,employmentId:string,today:string)=>{
 const to=addCalendarDays(today,COMING_UP_DAYS-1);
 const bundled=await shared(s,()=>readHomeTeamCalendarAndManagers(s,employmentId,today,to)).catch(()=>null);
 if(bundled)return managerAbsences(bundled.managerEmploymentIds,bundled.calendar.days);
 const [lines,calendar]=await shared(s,()=>Promise.all([reportingLinesFor(s,employmentId),readHomeTeamCalendar(s,employmentId,today,to)]));
 return managerAbsences(lines.managers.map(line=>line.employmentId),calendar.days);
});

/** At most this many of each kind of request are read; the tracker shows the first four overall. */
export const REQUEST_READ_LIMIT=5;
type Settled<T>={ok:true;value:T}|{ok:false};
const settle=async<T,>(read:()=>Promise<T>):Promise<Settled<T>>=>{try{return {ok:true,value:await read()};}catch{return {ok:false};}};
const dayOf=(value:Date|string)=>value instanceof Date?todayInKualaLumpur(value):String(value).length>10?todayInKualaLumpur(new Date(String(value))):String(value);
export type OwnRequests=Readonly<{requests:readonly TrackedRequest[];failed:boolean}>;
/** The person's own requests and where each one is: leave (the leave owner's own page read, newest applied first),
 * claims still open with an approver (the claims owner), and letters asked of HR (the letters owner's own lookup).
 * Bounded per owner; an owner that fails is left out and the panel says so. Modules not in use are not read. */
export const readOwnRequests=cache((s:SessionContext,employmentId:string,modules:Readonly<{leave:boolean;claims:boolean}>)=>
 withBackgroundReadWork(s.tenantId,()=>shared(s,async():Promise<OwnRequests>=>{
  const [leave,claims,letters]=await Promise.all([
   modules.leave?settle(()=>listLeaveRequestsPage(s,{employmentIds:[employmentId],statuses:['pending','approved','rejected'],sort:'applied',dir:'desc',limit:REQUEST_READ_LIMIT,offset:0})):null,
   modules.claims?settle(()=>listOpenClaimsForEmployment(s,employmentId)):null,
   settle(()=>listMyLetterRequests(s,{limit:REQUEST_READ_LIMIT})),
  ]);
  const out:TrackedRequest[]=[];
  if(leave?.ok)for(const row of leave.value.rows)out.push(Object.freeze({key:`leave:${row.id}`,kind:'leave' as const,label:row.leaveType,
   stage:row.status==='approved'?'approved' as const:row.status==='rejected'?'declined' as const:'waiting' as const,
   sent:dayOf(row.appliedOn as Date|string),startDate:row.startDate,endDate:row.endDate,href:'/leave'}));
  if(claims?.ok)for(const row of claims.value.filter(claim=>claim.status==='pending').slice(0,REQUEST_READ_LIMIT))
   out.push(Object.freeze({key:`claim:${row.id}`,kind:'claim' as const,label:row.typeName,stage:'waiting' as const,sent:dayOf(row.createdAt),href:'/claims'}));
  if(letters.ok)for(const row of letters.value)out.push(Object.freeze({key:`letter:${row.id}`,kind:'letter' as const,label:row.letterTypeName,
   stage:row.status==='issued'?'ready' as const:row.status==='declined'?'declined' as const:row.status==='in_progress'?'preparing' as const:'waiting' as const,
   sent:dayOf(row.createdAt),href:row.letterId?`/me/letters/${encodeURIComponent(row.letterId)}`:'/me/letters'}));
  return Object.freeze({requests:Object.freeze(out),failed:[leave,claims,letters].some(result=>result!==null&&!result.ok)});
 })));

/** Whether the Assistant may answer this person (the gate AI Centre Ask uses). A failed read offers no Ask. */
export const readAskAllowed=cache((s:SessionContext)=>shared(s,()=>mayUseAssistant(s)).then(access=>access.allowed).catch(()=>false));

/** Work assigned to the person to decide or act on (core/approvals-inbox.ts pendingTaskSummary), exactly as the Tasks page
 * reads it (app/tasks/page.tsx: no company filter, the same optional modules, notice acknowledgements included), so the
 * panel's count is the count its "See all" link opens. An entitlement snapshot that cannot be resolved reads a module as
 * off, as the Tasks page's quiet check does. */
export const readWaitingForYou=cache((s:SessionContext)=>shared(s,()=>{
 const on=(code:string)=>moduleState(s,code,null)==='on';
 return pendingTaskSummary(s,undefined,{attendance:on('attendance'),claims:on('claims'),performance:on('performance'),rewards:on('rewards')});
}));

/** The Notice Board, ported from the retired dashboard (owner decision, 12 Nov 2026): the person's newest live notices,
 * at most five, with the exact unread count, from the Notice owner's own Home reader (core/employee-home-notices.ts),
 * which proves the employment is the person's own first. */
export const readOwnNotices=cache((s:SessionContext,employmentId:string)=>shared(s,()=>readEmployeeHomeNotices(s,employmentId)));
