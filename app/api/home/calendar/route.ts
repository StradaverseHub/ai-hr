import {getSession} from '@/lib/session';
import {AuthRequiredError} from '@/lib/auth-errors';
import {HomeAccessError} from '@/core/employee-home';
import {readEmployeeHomeCalendar} from '@/core/employee-home-calendar';
import {homeCalendarMonth} from '@/lib/employee-home-calendar';
import {validateHomeTeamCalendar} from '@/lib/employee-home-sharing';

const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
export async function GET(request:Request){
 try{
  const session=await getSession(),query=new URL(request.url).searchParams;
  if([...query.keys()].some(key=>!['employmentId','month'].includes(key))||query.getAll('employmentId').length!==1
   ||!query.get('employmentId')||query.getAll('month').length>1)return Response.json({error:'invalid'},{status:400,headers});
  const month=query.get('month')??undefined;
  if(month!==undefined){try{homeCalendarMonth(month);}catch{return Response.json({error:'invalid'},{status:400,headers});}}
  const value=await readEmployeeHomeCalendar(session,query.get('employmentId')!,month);
  return Response.json({version:1,employmentId:value.employmentId,month:value.month,today:value.today,
   weekStartsOn:value.weekStartsOn,payrollEnabled:value.payrollEnabled,
   team:validateHomeTeamCalendar(value.team,value.days[0].date,value.days[value.days.length-1].date),days:value.days.map(day=>({date:day.date,canRequestLeave:day.canRequestLeave,
    entries:day.entries.map(entry=>entry.kind==='leave'?{kind:entry.kind,date:entry.date,status:entry.status,duration:entry.duration}:
     entry.kind==='holiday'?{kind:entry.kind,date:entry.date,name:entry.name,replacement:entry.replacement,tentative:entry.tentative}:{kind:entry.kind,date:entry.date})}))},{headers});
 }catch(error){
  const code=error instanceof AuthRequiredError?'authentication':error instanceof HomeAccessError?error.code:'unavailable';
  return Response.json({error:code},{status:code==='authentication'?401:code==='employmentUnavailable'?403:code==='chooseEmployment'?400:503,headers});
 }
}
