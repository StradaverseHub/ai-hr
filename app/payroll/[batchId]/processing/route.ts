import {requireAdmin} from '@/lib/authz';
import {payrollProcessingStatus} from '@/core/payroll-processing-job';
export const runtime='nodejs';
type Params={params:Promise<{batchId:string}>};
const headers={'Cache-Control':'private, no-store'};
/** The run's processing state for the run screen's progress panel (the status for every payroll operator who can
 * read the run; the job's progress for its creator). */
export async function GET(_request:Request,{params}:Params){
 const ctx=await requireAdmin();
 try{
  const status=await payrollProcessingStatus(ctx,(await params).batchId);
  if(status)return Response.json(status,{headers});
 }catch{/* an unreadable run is not found */}
 return Response.json({error:'Payroll run unavailable.'},{status:404,headers});
}
