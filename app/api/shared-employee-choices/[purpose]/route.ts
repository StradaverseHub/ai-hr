import {capacityAwareRoute} from '@/lib/database-degraded';
import {getSession} from '@/lib/session';
import {companyContextForPage} from '@/lib/scope';
import {AuthRequiredError} from '@/lib/auth-errors';
import {EmployeeChoiceInputError,EmployeeChoiceAccessError} from '@/core/employee-choice';
import {employeeChoiceRequestBody} from '@/core/employee-choice-request';
import {sharedEmployeePickerPage,type SharedEmployeePickerPurpose} from '@/core/shared-employee-picker';
import {isSameOriginBrowserRequest} from '@/lib/request-origin';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
export const POST=capacityAwareRoute(async function POST(request:Request,context:{params:Promise<{purpose:string}>}){
 if(!isSameOriginBrowserRequest(request))return Response.json({error:'origin'},{status:403,headers});
 try{
  const {purpose}=await context.params;
  if(!['scoped','active','loans'].includes(purpose))throw new EmployeeChoiceInputError();
  const s=await getSession(),input=await employeeChoiceRequestBody(request);
  const scope=purpose==='loans'?[]:(await companyContextForPage(s)).scopeIds;
  return Response.json(await sharedEmployeePickerPage(s,scope,purpose as SharedEmployeePickerPurpose,input),{headers});
 }catch(error){
  const status=error instanceof AuthRequiredError?401:error instanceof EmployeeChoiceInputError?400:error instanceof EmployeeChoiceAccessError?403:503;
  return Response.json({error:status===401?'authentication':status===400?'invalid':status===403?'forbidden':'unavailable'},{status,headers});
 }
});
