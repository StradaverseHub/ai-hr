/** Purpose-bound projections. Home does not gain Personnel/leave-row access, copy birth dates, or
 * interpret missing clock/leave evidence as office/WFH presence. SQL repeats current authority,
 * sharing configuration and person-wide celebration choices at each read, including pagination. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {requireOwnHomeSubject} from './employee-home';
import {todayInKualaLumpur} from '../lib/hr-date';
import {calendarWindowDates} from '../lib/calendar-window';
import {homeSharingPageInput,validateHomeTeamPage,validateHomeCelebrationPage,validateHomeTeamCalendar} from '../lib/employee-home-sharing';

export async function readHomeTeamPage(ctx:SessionContext,employmentId:string,p:{date?:string;after?:string;limit?:number;onlyLeave?:boolean}={}){
 const subject=await requireOwnHomeSubject(ctx,employmentId),on=p.date??todayInKualaLumpur();
 calendarWindowDates(on,on);const input=homeSharingPageInput(p.after,p.limit);
 return withTenant(ctx,async tx=>{
  const query=p.onlyLeave?sql`SELECT app.home_team_leave_page(${subject.employmentId}::uuid,${on}::date,${input.after}::uuid,${input.limit}::integer) AS projection`:
   sql`SELECT app.home_team_page(${subject.employmentId}::uuid,${on}::date,${input.after}::uuid,${input.limit}::integer) AS projection`;
  const [row]=await tx.execute(query) as unknown as {projection:unknown}[];
  return validateHomeTeamPage(row?.projection,on);
 });
}
export async function readHomeTeamCalendar(ctx:SessionContext,employmentId:string,from:string,to:string){
 const subject=await requireOwnHomeSubject(ctx,employmentId);calendarWindowDates(from,to);
 return withTenant(ctx,async tx=>{
  const [row]=await tx.execute(sql`SELECT app.home_team_calendar(${subject.employmentId}::uuid,${from}::date,${to}::date) AS projection`) as unknown as {projection:unknown}[];
  return validateHomeTeamCalendar(row?.projection,from,to);
 });
}
export async function readHomeCelebrationPage(ctx:SessionContext,employmentId:string,p:{after?:string;limit?:number}={}){
 const subject=await requireOwnHomeSubject(ctx,employmentId),input=homeSharingPageInput(p.after,p.limit,'celebration');
 return withTenant(ctx,async tx=>{
  const [row]=await tx.execute(sql`SELECT app.home_celebration_page(${subject.employmentId}::uuid,
   ${input.after}::text,${input.limit}::integer) AS projection`) as unknown as {projection:unknown}[];
  return validateHomeCelebrationPage(row?.projection);
 });
}
