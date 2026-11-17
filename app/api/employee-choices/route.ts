import {capacityAwareRoute} from '@/lib/database-degraded';
import {scopedSession} from '@/lib/scope';
import {AuthRequiredError} from '@/lib/auth-errors';
import {readEmployeeChoices,EmployeeChoiceInputError,EmployeeChoiceAccessError} from '@/core/employee-choice';
import {isSameOriginBrowserRequest} from '@/lib/request-origin';
import {employeeChoiceRequestBody} from '@/core/employee-choice-request';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
/** POST is a side-effect-free read: raw search stays out of URLs and access logs. */
export const POST = capacityAwareRoute(async function POST(request:Request){
 if(!isSameOriginBrowserRequest(request))return Response.json({error:'origin'},{status:403,headers});
 try{
  const {s,scopeIds}=await scopedSession();
  const input=await employeeChoiceRequestBody(request);
  const value=await readEmployeeChoices(s,{...input,companyIds:scopeIds},request.signal);
  return Response.json(value,{headers});
 }catch(error){
  const status=error instanceof AuthRequiredError?401:error instanceof EmployeeChoiceInputError?400:error instanceof EmployeeChoiceAccessError?403:503;
  return Response.json({error:status===401?'authentication':status===400?'invalid':status===403?'forbidden':'unavailable'},{status,headers});
 }
});
