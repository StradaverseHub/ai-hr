import {getSession} from '@/lib/session';
import {AuthRequiredError} from '@/lib/auth-errors';
import {HomeAccessError} from '@/core/employee-home';
import {readHomeTeamPage} from '@/core/employee-home-sharing';
import {homeSharingPageInput,validateHomeTeamResponse} from '@/lib/employee-home-sharing';
import {calendarWindowDates} from '@/lib/calendar-window';

const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
export async function GET(request:Request){
 try{
  const session=await getSession(),query=new URL(request.url).searchParams;
  if([...query.keys()].some(key=>!['employmentId','date','after','view'].includes(key))
   ||query.getAll('employmentId').length!==1||!query.get('employmentId')
   ||['date','after','view'].some(key=>query.getAll(key).length>1))return Response.json({error:'invalid'},{status:400,headers});
  const date=query.get('date')??undefined,after=query.get('after')??undefined,view=query.get('view');
  try{if(date!==undefined)calendarWindowDates(date,date);homeSharingPageInput(after);if(view!==null&&view!=='leave')throw Error('Invalid view');}
  catch{return Response.json({error:'invalid'},{status:400,headers});}
  const employmentId=query.get('employmentId')!,page=await readHomeTeamPage(session,employmentId,{date,after,onlyLeave:view==='leave'});
  return Response.json(validateHomeTeamResponse({version:1,employmentId,page},employmentId,date),{headers});
 }catch(error){
  const code=error instanceof AuthRequiredError?'authentication':error instanceof HomeAccessError?error.code:'unavailable';
  return Response.json({error:code},{status:code==='authentication'?401:code==='employmentUnavailable'?403:code==='chooseEmployment'?400:503,headers});
 }
}
