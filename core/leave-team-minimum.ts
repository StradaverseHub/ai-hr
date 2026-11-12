/** The per-company "minimum people present" leave setting (owner decision, 12 November 2026; draft migration 9770).
 *
 * One fact, one owner: `company.leave_team_minimum_present`, the fewest people of a team who must be present on any
 * day. NULL means no minimum. Only this module writes it (setLeaveTeamMinimum: authorization, the change and its audit
 * event in one transaction) and it is read in two places:
 *  - listLeaveTeamMinimums, the administrator's form on Leave Config > Company rules;
 *  - leaveTeamPresence, the approver recommendation's team_coverage check (core/recommenders/leave-decision.ts).
 *
 * THE TEAM is the Leave Calendar's Team view (app/leave/tracker/page.tsx) of the applicant's line manager: the
 * applicant's current administrative manager and every employment with a current, non-delegate reporting line to that
 * manager (core/read.ts reportingLinesFor's `reports`). An applicant with no current line manager has no team here, and
 * the recommendation falls back to its earlier check.
 *
 * PRESENT on a day: a team member other than the applicant who is employed that day (hired on or before it, not yet
 * terminated) and has no approved leave covering it. Hourly leave leaves a person present; full and half days do not.
 * Pending leave is not counted (it is not approved). The applicant counts as away, since the question is what
 * approving would leave. The days checked are the request's own leave dates (its per-date rows, or the leave type's
 * counted dates over the span).
 *
 * Every read runs as the caller, under row security, like the recommendation's other checks: the approver who decides
 * the request is the reader. It stays a recommendation; nothing here decides or blocks a request. */
import {and,asc,eq,inArray,isNull,sql} from 'drizzle-orm';
import {z} from 'zod';
import {withTenant,type SessionContext} from '../db/client';
import {actorOf,appendEvent} from '../db/events';
import {company,employment,leaveRequest,leaveRequestDate,leaveType} from '../db/schema';
import {countedDatesForSpan} from './leave';

/** Larger than any real team; a typing slip beyond it is refused rather than stored. */
export const LEAVE_TEAM_MINIMUM_MAX=10_000;
/** The longest request whose days are checked one by one (a year of dates). */
const PRESENCE_DAYS_MAX=366;

export type LeaveTeamMinimumRefusal='invalid'|'not_allowed';
export class LeaveTeamMinimumError extends Error{
 constructor(readonly code:LeaveTeamMinimumRefusal){
  super(code==='invalid'?'Enter a whole number of people from 0 to 10,000, or leave the box empty for no minimum.'
   :'You cannot change this setting for that company.');
  this.name='LeaveTeamMinimumError';
 }
}

/** The form's box: empty is "no minimum"; otherwise a whole number from 0 to LEAVE_TEAM_MINIMUM_MAX. */
export function parseLeaveTeamMinimum(raw:unknown):number|null{
 if(raw===null||raw===undefined)return null;
 if(typeof raw==='number'){if(Number.isSafeInteger(raw)&&raw>=0&&raw<=LEAVE_TEAM_MINIMUM_MAX)return raw;throw new LeaveTeamMinimumError('invalid');}
 if(typeof raw!=='string')throw new LeaveTeamMinimumError('invalid');
 const text=raw.trim();
 if(text==='')return null;
 if(!/^\d{1,6}$/.test(text))throw new LeaveTeamMinimumError('invalid');
 const value=Number(text);
 if(value>LEAVE_TEAM_MINIMUM_MAX)throw new LeaveTeamMinimumError('invalid');
 return value;
}

export type LeaveTeamMinimumRow=Readonly<{companyId:string;name:string;minimum:number|null}>;
/** The companies the caller administers (not archived), each with its minimum, by name. One statement. */
export function listLeaveTeamMinimums(ctx:SessionContext):Promise<LeaveTeamMinimumRow[]>{
 return withTenant(ctx,async tx=>(await tx.select({companyId:company.id,name:company.legalName,minimum:company.leaveTeamMinimumPresent}).from(company)
  .where(and(isNull(company.archivedAt),sql`app.is_admin_for(${company.id})`)).orderBy(asc(company.legalName),asc(company.id))));
}

export type LeaveTeamMinimumChange=Readonly<{companyId:string;before:number|null;after:number|null;changed:boolean}>;
/** Sets one company's minimum (null clears it). An administrator of that company only: anyone else, another tenant's
 * company or an archived one is refused before anything changes. The authorization, the change and the audit event
 * (company.leave-team-minimum.changed, with the before and after values) commit together; an unchanged save records
 * nothing. */
export async function setLeaveTeamMinimum(supplied:SessionContext,input:Readonly<{companyId:unknown;minimum:unknown}>):Promise<LeaveTeamMinimumChange>{
 const ctx:SessionContext={...supplied,roles:supplied.roles?.slice(),grants:supplied.grants?.map(grant=>({...grant}))};
 const minimum=parseLeaveTeamMinimum(input.minimum);
 const id=z.guid().safeParse(input.companyId);
 if(!id.success||!ctx.userId||ctx.agent)throw new LeaveTeamMinimumError('not_allowed');
 const companyId=id.data;
 return withTenant(ctx,async tx=>{
  // The row lock orders concurrent saves of the same company; no tenant-wide lock is taken.
  const [current]=await tx.select({minimum:company.leaveTeamMinimumPresent}).from(company)
   .where(and(eq(company.id,companyId),isNull(company.archivedAt),sql`app.is_admin_for(${company.id})`)).for('update');
  if(!current)throw new LeaveTeamMinimumError('not_allowed');
  const before=current.minimum??null;
  if(before===minimum)return Object.freeze({companyId,before,after:minimum,changed:false});
  const updated=await tx.update(company).set({leaveTeamMinimumPresent:minimum}).where(eq(company.id,companyId)).returning({id:company.id});
  // Row security on the update (admin-for-company) is the second, native refusal.
  if(updated.length!==1)throw new LeaveTeamMinimumError('not_allowed');
  await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'company',aggregateId:companyId,eventType:'company.leave-team-minimum.changed',
   actor:actorOf(ctx),payload:{before,after:minimum}});
  return Object.freeze({companyId,before,after:minimum,changed:true});
 });
}

export type LeaveTeamPresenceDay=Readonly<{date:string;present:number}>;
export type LeaveTeamPresence=
 /** The applicant's company sets no minimum: the recommendation is unchanged. */
 |Readonly<{kind:'no_minimum'}>
 /** A minimum is set but the applicant has no current line manager, so there is no team to count. */
 |Readonly<{kind:'no_team';minimum:number}>
 /** Each day of the request, in date order, with how many of the team would be present if it were approved. */
 |Readonly<{kind:'presence';minimum:number;teamSize:number;days:readonly LeaveTeamPresenceDay[]}>;

/** Who of the applicant's team would be present on each day of one leave request, read as the caller. A request the
 * caller cannot see, or one too long to check day by day, throws (the recommendation then reads the check as missing).
 * At most five statements whatever the size of the tenant: the request with its company's minimum, its dates (and,
 * without per-date rows, the leave type's calendar), and one set-based count over every day. */
export async function leaveTeamPresence(ctx:SessionContext,p:Readonly<{leaveRequestId:string;today:string}>):Promise<LeaveTeamPresence>{
 return withTenant(ctx,async tx=>{
  const [request]=await tx.select({employmentId:leaveRequest.employmentId,personId:employment.personId,startDate:leaveRequest.startDate,endDate:leaveRequest.endDate,
   minimum:company.leaveTeamMinimumPresent,counting:leaveType.counting,dayTypeInclusion:leaveType.dayTypeInclusion}).from(leaveRequest)
   .innerJoin(employment,eq(employment.id,leaveRequest.employmentId)).innerJoin(company,eq(company.id,employment.companyId))
   .innerJoin(leaveType,eq(leaveType.id,leaveRequest.leaveTypeId)).where(eq(leaveRequest.id,p.leaveRequestId)).limit(1);
  if(!request)throw new Error('The leave request could not be read.');
  if(request.minimum===null||request.minimum===undefined)return Object.freeze({kind:'no_minimum' as const});
  const minimum=request.minimum;
  const recorded=await tx.select({date:leaveRequestDate.leaveDate}).from(leaveRequestDate)
   .where(and(eq(leaveRequestDate.leaveRequestId,p.leaveRequestId),inArray(leaveRequestDate.status,['pending','approved']))).orderBy(asc(leaveRequestDate.leaveDate));
  const dates=recorded.length?recorded.map(row=>String(row.date))
   :await countedDatesForSpan(tx,request.employmentId,String(request.startDate),String(request.endDate),request.counting,request.dayTypeInclusion);
  if(dates.length>PRESENCE_DAYS_MAX)throw new Error('The leave request is too long to check day by day.');
  const rows=await tx.execute(sql`
   WITH mgr AS (
    SELECT r.manager_employment_id AS id FROM reporting_line r
    WHERE r.subordinate_employment_id=${request.employmentId}::uuid AND r.line_type='administrative' AND r.superseded_at IS NULL
     AND r.valid_from<=${p.today}::date AND (r.valid_to IS NULL OR r.valid_to>${p.today}::date)
   ), team AS (
    SELECT mgr.id AS employment_id FROM mgr
    UNION
    SELECT r.subordinate_employment_id FROM reporting_line r JOIN mgr ON r.manager_employment_id=mgr.id
    WHERE r.line_type<>'delegate' AND r.superseded_at IS NULL AND r.valid_from<=${p.today}::date AND (r.valid_to IS NULL OR r.valid_to>${p.today}::date)
   ), members AS (
    SELECT DISTINCT e.id,e.person_id,e.hired_on,e.terminated_on FROM employment e JOIN team t ON t.employment_id=e.id
    WHERE e.person_id<>${request.personId}::uuid
   ), days AS (
    SELECT DISTINCT d::date AS day FROM unnest(string_to_array(${dates.join(',')},',')) d WHERE d<>''
   )
   SELECT days.day::text AS date,
    (SELECT count(DISTINCT m.person_id)::int FROM members m
     WHERE m.hired_on<=days.day AND (m.terminated_on IS NULL OR m.terminated_on>days.day)
      AND NOT EXISTS (
       SELECT 1 FROM leave_request lr
       WHERE lr.employment_id=m.id AND lr.status='approved' AND lr.duration_type<>'hourly'
        AND lr.start_date<=days.day AND lr.end_date>=days.day
        AND (NOT EXISTS (SELECT 1 FROM leave_request_date x WHERE x.leave_request_id=lr.id)
         OR EXISTS (SELECT 1 FROM leave_request_date x WHERE x.leave_request_id=lr.id AND x.leave_date=days.day AND x.status='approved')))) AS present,
    (SELECT count(DISTINCT m.person_id)::int FROM members m) AS others,
    (SELECT count(*)::int FROM mgr) AS managers
   FROM days ORDER BY days.day`) as unknown as {date:string;present:number;others:number;managers:number}[];
  const managers=rows.length?Number(rows[0].managers):Number((await tx.execute(sql`SELECT count(*)::int AS n FROM reporting_line r
   WHERE r.subordinate_employment_id=${request.employmentId}::uuid AND r.line_type='administrative' AND r.superseded_at IS NULL
    AND r.valid_from<=${p.today}::date AND (r.valid_to IS NULL OR r.valid_to>${p.today}::date)`) as unknown as {n:number}[])[0]?.n??0);
  if(managers===0)return Object.freeze({kind:'no_team' as const,minimum});
  const others=rows.length?Number(rows[0].others):0;
  return Object.freeze({kind:'presence' as const,minimum,teamSize:others+1,
   days:Object.freeze(rows.map(row=>Object.freeze({date:String(row.date),present:Number(row.present)})))});
 });
}
