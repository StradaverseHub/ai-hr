import {requireAdmin} from '@/lib/authz';
import {getMovementImportRevertJob} from '@/core/movement-import-revert-job';
import {BulkJobError} from '@/core/bulk-job';
export const runtime='nodejs';
type Params={params:Promise<{jobId:string}>};
const headers={'Cache-Control':'private, no-store'};
/** Progress of the signed-in user's own background revert (creator-only by row security). */
export async function GET(_request:Request,{params}:Params){
 const ctx=await requireAdmin();
 try{return Response.json({job:await getMovementImportRevertJob(ctx,(await params).jobId)},{headers});}
 catch(error){
  if(error instanceof BulkJobError)return Response.json({error:'Revert unavailable.'},{status:error.status,headers});
  return Response.json({error:'The revert progress could not be read. Reopen this page.'},{status:500,headers});
 }
}
