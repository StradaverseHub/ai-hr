import {revalidatePath} from 'next/cache';
import {requireAdmin} from '@/lib/authz';
import {getMovementCheckJob,movementImportJobHttpError} from '@/core/movement-import-job';
export const runtime='nodejs';
type Params={params:Promise<{jobId:string}>};
/** One background movement file check's progress and, once finished, its recorded attempt and preview (creator only).
 * A finished check is in Import History, which the synchronous check refreshed as it returned. */
export async function GET(_request:Request,{params}:Params){
 const ctx=await requireAdmin();
 try{
  const job=await getMovementCheckJob(ctx,(await params).jobId);
  if(job.state==='completed')revalidatePath('/admin/personnel/import/history');
  return Response.json({job},{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){return movementImportJobHttpError(error);}
}
