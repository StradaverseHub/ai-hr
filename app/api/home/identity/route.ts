import {getSession} from '@/lib/session';
import {AuthRequiredError} from '@/lib/auth-errors';
import {HomeAccessError,readEmployeeHomeIdentity} from '@/core/employee-home';

const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
export async function GET(request:Request){
 try{
  const session=await getSession(),query=new URL(request.url).searchParams;
  if([...query.keys()].some(key=>key!=='employmentId')||query.getAll('employmentId').length>1)
   return Response.json({error:'invalid'},{status:400,headers});
  const identity=await readEmployeeHomeIdentity(session,query.get('employmentId')??undefined);
  return Response.json({version:identity.version,name:identity.name,photoHref:identity.photoHref,role:identity.role,
   employmentState:identity.employmentState,selectedEmploymentId:identity.selectedEmploymentId,companyEstablished:identity.companyEstablished,
   employments:identity.employments.map(row=>({employmentId:row.employmentId,employeeCode:row.employeeCode,company:row.company}))},{headers});
 }catch(error){
  const code=error instanceof AuthRequiredError?'authentication':error instanceof HomeAccessError?error.code:'unavailable';
  return Response.json({error:code},{status:code==='authentication'?401:code==='employmentUnavailable'?403:code==='chooseEmployment'?400:503,headers});
 }
}
