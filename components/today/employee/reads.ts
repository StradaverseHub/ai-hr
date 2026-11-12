/** Employee Today (owner decision, 11 Nov 2026): every fact the one-pager shows, read from its existing owner as the
 * person, for their own selected employment.
 *
 * AUTHORIZE FIRST. readOwnContext proves the own employment (core/employee-home.ts: the actual login, the own-subject
 * inventory and the dated company, in one read-only snapshot) before any panel reads; a panel only ever receives that
 * proven employment id, and each owner below repeats its own checks under row-level security.
 *
 * ONE BOUNDED READ PER PANEL. Each reader is memoised for the render (React cache), so a fact two panels show (the
 * Before payroll checklist's due dates and cut-off, the month's Home calendar) is read once. The own-fact readers are
 * core/employee-today-reads.ts, which the native Today (core/mobile-today.ts) reads too; this module memoises them.
 * Every reader joins the render's shared read-only snapshot (lib/request-read-scope.ts). The request tracker fans out
 * to three owners and so runs under withBackgroundReadWork (docs/architecture/FUTURE-BUILD-CONTRACT.md). Nothing here
 * writes, computes a balance, an amount or a date: those are each owner's own answers. */
import {cache} from 'react';
import {withBackgroundReadWork,type SessionContext} from '@/db/client';
import * as own from '@/core/employee-today-reads';
import {readEmployeeHomeTimeOff} from '@/core/employee-home-time-off';
import {listLeaveRequestsPage} from '@/core/read';
import {listOpenClaimsForEmployment} from '@/packs/claims/service';
import {listMyLetterRequests} from '@/core/letter-requests';
import {mayUseAssistant} from '@/core/assistant-grant';
import {pendingTaskSummary} from '@/core/approvals-inbox';
import {todayInKualaLumpur} from '@/lib/hr-date';
import {type TrackedRequest} from '@/lib/today/employee';

const shared=own.sharedOwnRead;

/** A module for the person's own company: on, off, or failed (the entitlement could not be resolved). */
export const moduleState=own.moduleState;
/** The Home team calendar's look-ahead for Coming up: today and the next 13 days. */
export const COMING_UP_DAYS=own.COMING_UP_DAYS;

/** The person's own selection, role and dated company (core/employee-today-reads.ts). */
export const readOwnContext=cache(own.readOwnContext);
/** The person's own Before payroll checklist, without their approvals as an approver. null: payroll is not in use. */
export const readOwnReadiness=cache(own.readOwnReadiness);
/** The passports the documents loop found expiring for the person (their own open cases only). */
export const readOwnPassportCards=cache(own.readOwnPassportCards);
/** The payroll owner's own metadata: the next recorded payment date and the latest released payslips. No amount. */
export const readOwnPayHints=cache(own.readOwnPayHints);
/** The leave service's own figures for the person (core/employee-home-time-off.ts). */
export const readOwnTimeOff=cache((s:SessionContext,employmentId:string,locale:string)=>shared(s,()=>readEmployeeHomeTimeOff(s,employmentId,locale)));
/** The person's own Home calendar for a month: their leave, holidays and recorded paydays. */
export const readOwnCalendar=cache(own.readOwnCalendar);
/** The attendance owner's own day rows for Monday to Sunday of this week. */
export const readOwnWeek=cache(own.readOwnWeek);
/** The person's managers away in the next COMING_UP_DAYS days, from the Home team calendar (its own sharing policy). */
export const readManagersAway=cache(own.readManagersAway);

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
