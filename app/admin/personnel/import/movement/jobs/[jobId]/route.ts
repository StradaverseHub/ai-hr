import {revalidatePath} from 'next/cache';
import {requireAdmin} from '@/lib/authz';
import {getMovementImportJob,movementImportJobHttpError} from '@/core/movement-import-job';
export const runtime='nodejs';
type Params={params:Promise<{jobId:string}>};
/** One background movement import's progress and, once finished, its result (creator only). The first poll that
 * sees saved movements invalidates the pages the synchronous confirmation used to, as it returned. */
export async function GET(_request:Request,{params}:Params){
 const ctx=await requireAdmin();
 try{
  const job=await getMovementImportJob(ctx,(await params).jobId);
  if(job.state==='completed'&&job.result?.imported){revalidatePath('/admin/personnel');for(const employee of job.result.employees)if(employee.employmentId)revalidatePath('/admin/personnel/'+employee.employmentId);revalidatePath('/admin/personnel/import/history');}
  return Response.json({job},{headers:{'Cache-Control':'private, no-store'}});
 }catch(error){return movementImportJobHttpError(error);}
}
