import {getSession} from '@/lib/session';
import {AuthRequiredError} from '@/lib/auth-errors';
import {HomeAccessError,readEmployeeHomePayHints} from '@/core/employee-home';
import {OwnPayrollSubjectUnavailableError} from '@/packs/payroll/service';

const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
export async function GET(request:Request){
 try{
  const session=await getSession(),query=new URL(request.url).searchParams;
  if([...query.keys()].some(key=>key!=='employmentId')||query.getAll('employmentId').length>1)
   return Response.json({error:'invalid'},{status:400,headers});
  const value=await readEmployeeHomePayHints(session,query.get('employmentId')??undefined);
  return Response.json({version:value.version,employmentId:value.employmentId,
   payslips:value.payslips.map(row=>({id:row.id,period:row.period,runType:row.runType,runSequence:row.runSequence})),
   nextPayment:value.nextPayment?{date:value.nextPayment.date,period:value.nextPayment.period,runType:value.nextPayment.runType}:null},{headers});
 }catch(error){
  const code=error instanceof AuthRequiredError?'authentication':error instanceof OwnPayrollSubjectUnavailableError?'employmentUnavailable':error instanceof HomeAccessError?error.code:'unavailable';
  return Response.json({error:code},{status:code==='authentication'?401:code==='employmentUnavailable'?403:code==='chooseEmployment'?400:503,headers});
 }
}
