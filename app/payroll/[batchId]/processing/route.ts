import {requireAdmin} from '@/lib/authz';
import {payrollProcessingStatus} from '@/core/payroll-processing-job';
import {isBulkJobId} from '@/core/bulk-job';
import {payrollProgressReadFailed} from '@/lib/payroll-progress-poll';
export const runtime='nodejs';
type Params={params:Promise<{batchId:string}>};
const headers={'Cache-Control':'private, no-store'};
const unavailable=()=>Response.json({error:'Payroll run unavailable.'},{status:404,headers});
/** The run's processing state for the run screen's progress panel (the status for every payroll operator who can
 * read the run; the job's progress for its creator). A run the caller cannot read is not found; a read that could
 * not finish is a 503 the panel retries (lib/payroll-progress-poll.ts). */
export async function GET(_request:Request,{params}:Params){
 const ctx=await requireAdmin();
 const batchId=(await params).batchId;
 if(!isBulkJobId(batchId))return unavailable();
 let status;
 try{status=await payrollProcessingStatus(ctx,batchId);}
 catch(error){return payrollProgressReadFailed('payroll processing status',error,headers);}
 if(status)return Response.json(status,{headers});
 return unavailable();
}
