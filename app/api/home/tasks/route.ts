import {getSession} from '@/lib/session';
import {AuthRequiredError} from '@/lib/auth-errors';
import {HomeAccessError} from '@/core/employee-home';
import {readEmployeeHomeTasks} from '@/core/employee-home-tasks';
import {tasksProjection} from '../personal-projections';

const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
export async function GET(request:Request){
 try{
  const session=await getSession(),query=new URL(request.url).searchParams,page=query.get('page');
  if([...query.keys()].some(key=>!['employmentId','page'].includes(key))
   ||query.getAll('employmentId').length>1||query.getAll('page').length>1||page!==null&&!/^[1-9]\d{0,5}$/.test(page))
   return Response.json({error:'invalid'},{status:400,headers});
  const value=await readEmployeeHomeTasks(session,query.get('employmentId')??undefined,page===null?undefined:Number(page));
  return Response.json(tasksProjection(value),{headers});
 }catch(error){
  const code=error instanceof AuthRequiredError?'authentication':error instanceof HomeAccessError?error.code:'unavailable';
  return Response.json({error:code},{status:code==='authentication'?401:code==='employmentUnavailable'?403:code==='chooseEmployment'?400:503,headers});
 }
}
