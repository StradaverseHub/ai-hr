/** Manager Today's "Your team today" (owner decision, 12 Nov 2026, porting the retired dashboard's attendance card):
 * how many of the viewer's own reports were recorded present, late, on a half day or absent on one day.
 *
 * ONE STATEMENT, BOUNDED BY THE TEAM. The population is `app.my_team_report_ids()` (migration 0507), the same reports
 * My Team shows: the viewer's own current employments and everyone below them on current administrative reporting
 * lines. A person with no reports gets zeros, never another population. The day's rows are found through the
 * (employment_id, attendance_date) unique index and counted by status in SQL, so a large team never loads its rows.
 * Row-level security still applies to every attendance row, and the company switcher narrows the count when it
 * names companies. The old dashboard counted the most recent recorded day for every visible employee of the
 * selected companies; this counts the given day for the viewer's team only. */
import {and,eq,inArray,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../../db/client';
import {attendance,employment} from '../../db/schema';

export type TeamAttendanceToday=Readonly<{date:string;present:number;late:number;halfDay:number;absent:number}>;

export function teamAttendanceToday(ctx:SessionContext,p:Readonly<{date:string;scopeIds:readonly string[]}>):Promise<TeamAttendanceToday>{
 if(!/^\d{4}-\d{2}-\d{2}$/.test(p.date))throw Error('A calendar day is required.');
 const scopeIds=[...p.scopeIds];
 return withTenant(ctx,async tx=>{
  const rows=await tx.select({status:attendance.status,n:sql<number>`count(*)::int`}).from(attendance)
   .innerJoin(employment,eq(employment.id,attendance.employmentId))
   .where(and(eq(attendance.attendanceDate,p.date),sql`${attendance.employmentId} IN (SELECT app.my_team_report_ids())`,
    scopeIds.length?inArray(employment.companyId,scopeIds):undefined))
   .groupBy(attendance.status);
  const n=(status:string)=>rows.find(row=>row.status===status)?.n??0;
  return Object.freeze({date:p.date,present:n('present'),late:n('late'),halfDay:n('half_day'),absent:n('absent')});
 },{readOnlySnapshot:true});
}
