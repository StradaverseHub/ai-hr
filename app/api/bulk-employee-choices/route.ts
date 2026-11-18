import {capacityAwareRoute} from '@/lib/database-degraded';
import {getSession} from '@/lib/session';
import {AuthRequiredError} from '@/lib/auth-errors';
import {bulkEmployeePicker,resolveBulkEmployeeSelection} from '@/core/bulk-employee-picker';
import {EmployeeChoiceAccessError,EmployeeChoiceInputError} from '@/core/employee-choice';
import {bulkEmployeePickerRequest} from '@/core/bulk-employee-picker-request';
import {isSameOriginBrowserRequest} from '@/lib/request-origin';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
/** Fresh cookie principal, no posted population/scope. The query stays out of URLs. */
export const POST=capacityAwareRoute(async function POST(request:Request){
 if(request.headers.has('authorization')||!isSameOriginBrowserRequest(request))return Response.json({error:'origin'},{status:403,headers});
 try{
  const s=await getSession(),input=await bulkEmployeePickerRequest(request);
  return Response.json(input.operation==='resolve'?await resolveBulkEmployeeSelection(s,input.picked,input.raw,request.signal)
   :await bulkEmployeePicker(s,{query:input.query,offset:input.offset,all:input.operation==='all'},request.signal),{headers});
 }catch(error){
  const status=error instanceof AuthRequiredError?401:error instanceof EmployeeChoiceInputError?400:error instanceof EmployeeChoiceAccessError?403:503;
  return Response.json({error:status===401?'authentication':status===400?'invalid':status===403?'forbidden':'unavailable'},{status,headers});
 }
});
