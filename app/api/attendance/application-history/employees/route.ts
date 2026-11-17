import {capacityAwareRoute} from '@/lib/database-degraded';
import {scopedSession} from '@/lib/scope';
import {AuthRequiredError} from '@/lib/auth-errors';
import {isAdmin} from '@/lib/authz-model';
import {EmployeeChoiceInputError,EmployeeChoiceAccessError} from '@/core/employee-choice';
import {employeeChoiceRequestBody} from '@/core/employee-choice-request';
import {attendanceApplicationEmployeeChoices} from '@/core/attendance-application-history';
import {isSameOriginBrowserRequest} from '@/lib/request-origin';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
export const POST=capacityAwareRoute(async function POST(request:Request){
 if(!isSameOriginBrowserRequest(request))return Response.json({error:'origin'},{status:403,headers});
 try{
  const {s,scopeIds}=await scopedSession();if(!isAdmin(s))throw new EmployeeChoiceAccessError();
  const input=await employeeChoiceRequestBody(request);
  if(input.limit!==undefined&&input.limit!==25||input.labelMode!==undefined&&input.labelMode!=='names')throw new EmployeeChoiceInputError();
  return Response.json(await attendanceApplicationEmployeeChoices(s,scopeIds,input,request.signal),{headers});
 }catch(error){
  const status=error instanceof AuthRequiredError?401:error instanceof EmployeeChoiceInputError?400:error instanceof EmployeeChoiceAccessError?403:503;
  return Response.json({error:status===401?'authentication':status===400?'invalid':status===403?'forbidden':'unavailable'},{status,headers});
 }
});
