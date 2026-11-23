import {requireAdmin} from '@/lib/authz';
import {payrollProcessingStatus} from '@/core/payroll-processing-job';
import {isBulkJobId} from '@/core/bulk-job';
import {isPayrollProgressBusy,payrollProgressBusy} from '@/lib/payroll-progress-poll.server';
export const runtime='nodejs';
type Params={params:Promise<{batchId:string}>};
const headers={'Cache-Control':'private, no-store'};
/** The run's processing state for the run screen's progress panel (the status for every payroll operator who can
 * read the run; the job's progress for its creator). A busy read is a 503 the panel retries
 * (lib/payroll-progress-poll.server.ts); a run that cannot be read is not found. */
export async function GET(_request:Request,{params}:Params){
 const ctx=await requireAdmin();
 const batchId=(await params).batchId;
 if(isBulkJobId(batchId)){
  try{
   const status=await payrollProcessingStatus(ctx,batchId);
   if(status)return Response.json(status,{headers});
  }catch(error){
   if(isPayrollProgressBusy(error))return payrollProgressBusy('payroll processing status',error,headers);
   /* any other unreadable run is not found */
  }
 }
 return Response.json({error:'Payroll run unavailable.'},{status:404,headers});
}
