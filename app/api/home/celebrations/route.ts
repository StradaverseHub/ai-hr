import {getSession} from '@/lib/session';
import {AuthRequiredError} from '@/lib/auth-errors';
import {HomeAccessError} from '@/core/employee-home';
import {readHomeCelebrationPage} from '@/core/employee-home-sharing';
import {homeSharingPageInput,validateHomeCelebrationResponse} from '@/lib/employee-home-sharing';

const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
/** Read-only: viewing or paging never sends a greeting or opts anybody in. */
export async function GET(request:Request){
 try{
  const session=await getSession(),query=new URL(request.url).searchParams;
  if([...query.keys()].some(key=>!['employmentId','after'].includes(key))
   ||query.getAll('employmentId').length!==1||!query.get('employmentId')
   ||query.getAll('after').length>1)return Response.json({error:'invalid'},{status:400,headers});
  const after=query.get('after')??undefined;
  try{homeSharingPageInput(after,20,'celebration');}
  catch{return Response.json({error:'invalid'},{status:400,headers});}
  const employmentId=query.get('employmentId')!,page=await readHomeCelebrationPage(session,employmentId,{after});
  return Response.json(validateHomeCelebrationResponse({version:1,employmentId,page},employmentId),{headers});
 }catch(error){
  const code=error instanceof AuthRequiredError?'authentication':error instanceof HomeAccessError?error.code:'unavailable';
  return Response.json({error:code},{status:code==='authentication'?401:code==='employmentUnavailable'?403:code==='chooseEmployment'?400:503,headers});
 }
}
