import {getSession} from '@/lib/session';
import {AuthRequiredError} from '@/lib/auth-errors';
import {HomeAccessError} from '@/core/employee-home';
import {OwnClockEmploymentUnavailableError} from '@/packs/attendance/service';
import {OwnPayrollSubjectUnavailableError} from '@/packs/payroll/service';
import {readEmployeeHomeToday} from '@/core/employee-home-today';
import {withDatabaseReadCancellation} from '@/db/workload';
import {todayProjection} from '../personal-projections';

const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
export async function GET(request:Request){
 try{
  const session=await getSession(),query=new URL(request.url).searchParams;
  if([...query.keys()].some(key=>key!=='employmentId')||query.getAll('employmentId').length!==1||!query.get('employmentId'))return Response.json({error:'invalid'},{status:400,headers});
  const value=await withDatabaseReadCancellation(request.signal,()=>readEmployeeHomeToday(session,query.get('employmentId')!,request.signal));
  return Response.json(todayProjection(value),{headers});
 }catch(error){
  const code=error instanceof AuthRequiredError?'authentication':error instanceof HomeAccessError?error.code:
   error instanceof OwnClockEmploymentUnavailableError||error instanceof OwnPayrollSubjectUnavailableError?'employmentUnavailable':'unavailable';
  return Response.json({error:code},{status:code==='authentication'?401:code==='employmentUnavailable'?403:code==='chooseEmployment'?400:503,headers});
 }
}
