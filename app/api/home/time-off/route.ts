import {getSession} from '@/lib/session';
import {getLocale} from 'next-intl/server';
import {AuthRequiredError} from '@/lib/auth-errors';
import {HomeAccessError} from '@/core/employee-home';
import {readEmployeeHomeTimeOff} from '@/core/employee-home-time-off';

const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
export async function GET(request:Request){
 try{
  const session=await getSession(),query=new URL(request.url).searchParams;
  if([...query.keys()].some(key=>key!=='employmentId')||query.getAll('employmentId').length>1)
   return Response.json({error:'invalid'},{status:400,headers});
  const value=await readEmployeeHomeTimeOff(session,query.get('employmentId')??undefined,await getLocale());
  return Response.json({version:value.version,employmentId:value.employmentId,asOf:value.asOf,canApply:value.canApply,
   balances:value.balances.map(row=>({id:row.id,name:row.name,annualLeave:row.annualLeave,available:row.available,pending:row.pending})),
   nextApproved:value.nextApproved?{requestId:value.nextApproved.requestId,date:value.nextApproved.date,duration:value.nextApproved.duration}:null},{headers});
 }catch(error){
  const code=error instanceof AuthRequiredError?'authentication':error instanceof HomeAccessError?error.code:'unavailable';
  return Response.json({error:code},{status:code==='authentication'?401:code==='employmentUnavailable'?403:code==='chooseEmployment'?400:503,headers});
 }
}
