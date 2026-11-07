import {getSession} from '@/lib/session';
import {AuthRequiredError} from '@/lib/auth-errors';
import {HomeAccessError} from '@/core/employee-home';
import {readEmployeeHomeCalendar} from '@/core/employee-home-calendar';
import {homeCalendarMonth} from '@/lib/employee-home-calendar';
import {calendarProjection} from '../personal-projections';
import {withDatabaseReadCancellation} from '@/db/workload';

const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
export async function GET(request:Request){
 try{
  const session=await getSession(),query=new URL(request.url).searchParams;
  if([...query.keys()].some(key=>!['employmentId','month'].includes(key))||query.getAll('employmentId').length!==1
   ||!query.get('employmentId')||query.getAll('month').length>1)return Response.json({error:'invalid'},{status:400,headers});
  const month=query.get('month')??undefined;
  if(month!==undefined){try{homeCalendarMonth(month);}catch{return Response.json({error:'invalid'},{status:400,headers});}}
  const value=await withDatabaseReadCancellation(request.signal,()=>readEmployeeHomeCalendar(session,query.get('employmentId')!,month,undefined,request.signal));
  return Response.json(calendarProjection(value),{headers});
 }catch(error){
  const code=error instanceof AuthRequiredError?'authentication':error instanceof HomeAccessError?error.code:'unavailable';
  return Response.json({error:code},{status:code==='authentication'?401:code==='employmentUnavailable'?403:code==='chooseEmployment'?400:503,headers});
 }
}
