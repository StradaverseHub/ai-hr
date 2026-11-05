/** Purpose-bound projections. Home does not gain Personnel/leave-row access, copy birth dates, or
 * interpret missing clock/leave evidence as office/WFH presence. SQL repeats current authority,
 * sharing configuration and person-wide celebration choices at each read, including pagination. */
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import {HomeAccessError} from './employee-home';
import {isCurrentOwnHomeEmploymentTx} from './read';
import {todayInKualaLumpur} from '../lib/hr-date';
import {calendarWindowDates} from '../lib/calendar-window';
import {homeSharingPageInput,validateHomeTeamPage,validateHomeCelebrationPage,validateHomeTeamCalendar} from '../lib/employee-home-sharing';

function withOwnHomeSharingRead<T>(ctx:SessionContext,employmentId:string,read:(tx:Tx)=>Promise<T>){
 if(!ctx.userId)throw new HomeAccessError('authentication');
 return withTenant(ctx,async tx=>{
  if(!await isCurrentOwnHomeEmploymentTx(tx,ctx,employmentId))throw new HomeAccessError('employmentUnavailable');
  return read(tx);
 });
}

export async function readHomeTeamPage(ctx:SessionContext,employmentId:string,p:{date?:string;after?:string;limit?:number;onlyLeave?:boolean}={}){
 return withOwnHomeSharingRead(ctx,employmentId,async tx=>{
  const on=p.date??todayInKualaLumpur();
  calendarWindowDates(on,on);const input=homeSharingPageInput(p.after,p.limit);
  const query=p.onlyLeave?sql`SELECT app.home_team_leave_page(${employmentId}::uuid,${on}::date,${input.after}::uuid,${input.limit}::integer) AS projection`:
   sql`SELECT app.home_team_page(${employmentId}::uuid,${on}::date,${input.after}::uuid,${input.limit}::integer) AS projection`;
  const [row]=await tx.execute(query) as unknown as {projection:unknown}[];
  return validateHomeTeamPage(row?.projection,on);
 });
}
export async function readHomeTeamCalendar(ctx:SessionContext,employmentId:string,from:string,to:string){
 return withOwnHomeSharingRead(ctx,employmentId,async tx=>{
  calendarWindowDates(from,to);
  const [row]=await tx.execute(sql`SELECT app.home_team_calendar(${employmentId}::uuid,${from}::date,${to}::date) AS projection`) as unknown as {projection:unknown}[];
  return validateHomeTeamCalendar(row?.projection,from,to);
 });
}
export async function readHomeCelebrationPage(ctx:SessionContext,employmentId:string,p:{after?:string;limit?:number}={}){
 return withOwnHomeSharingRead(ctx,employmentId,async tx=>{
  const input=homeSharingPageInput(p.after,p.limit,'celebration');
  const [row]=await tx.execute(sql`SELECT app.home_celebration_page(${employmentId}::uuid,
   ${input.after}::text,${input.limit}::integer) AS projection`) as unknown as {projection:unknown}[];
  return validateHomeCelebrationPage(row?.projection);
 });
}
