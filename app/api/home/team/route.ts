import {getSession} from '@/lib/session';
import {sharingError,sharingHeaders as headers,teamResponse} from '../sharing-responses';
import {homeSharingPageInput} from '@/lib/employee-home-sharing';
import {calendarWindowDates} from '@/lib/calendar-window';

export async function GET(request:Request){
 try{
  const session=await getSession(),query=new URL(request.url).searchParams;
  if([...query.keys()].some(key=>!['employmentId','date','after','view'].includes(key))
   ||query.getAll('employmentId').length!==1||!query.get('employmentId')
   ||['date','after','view'].some(key=>query.getAll(key).length>1))return Response.json({error:'invalid'},{status:400,headers});
  const date=query.get('date')??undefined,after=query.get('after')??undefined,view=query.get('view');
  try{if(date!==undefined)calendarWindowDates(date,date);homeSharingPageInput(after);if(view!==null&&view!=='leave')throw Error('Invalid view');}
  catch{return Response.json({error:'invalid'},{status:400,headers});}
  return Response.json(await teamResponse(session,query.get('employmentId')!,{date,after,onlyLeave:view==='leave'}),{headers});
 }catch(error){
  const {code,status}=sharingError(error);
  return Response.json({error:code},{status,headers});
 }
}
