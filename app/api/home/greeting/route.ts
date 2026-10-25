import {getSession} from '@/lib/session';
import {AuthRequiredError} from '@/lib/auth-errors';
import {HomeAccessError,readEmployeeHomeGreetingIdentity} from '@/core/employee-home';

const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
export async function GET(request:Request){
 try{
  const session=await getSession(),query=new URL(request.url).searchParams;
  if([...query.keys()].some(key=>key!=='employmentId')||query.getAll('employmentId').length>1)
   return Response.json({error:'invalid'},{status:400,headers});
  const greeting=await readEmployeeHomeGreetingIdentity(session,query.get('employmentId')??undefined);
  return Response.json({version:greeting.version,employmentId:greeting.employmentId,name:greeting.name,photoHref:greeting.photoHref},{headers});
 }catch(error){
  const code=error instanceof AuthRequiredError?'authentication':error instanceof HomeAccessError?error.code:'unavailable';
  return Response.json({error:code},{status:code==='authentication'?401:code==='employmentUnavailable'?403:code==='chooseEmployment'?400:503,headers});
 }
}
