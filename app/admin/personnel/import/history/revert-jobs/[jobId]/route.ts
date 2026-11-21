import {requireAdmin} from '@/lib/authz';
import {EMPLOYEE_IMPORT_REVERT_KIND,employeeImportRevertProgress} from '@/core/employee-import-revert-job';
import {MOVEMENT_REVERT_KIND,movementImportRevertProgress} from '@/core/movement-import-revert-job';
import {BulkJobError,readBulkJob} from '@/core/bulk-job';
export const runtime='nodejs';
type Params={params:Promise<{jobId:string}>};
const headers={'Cache-Control':'private, no-store'};
/** Progress of the signed-in user's own background revert (creator-only by row security): the employee import revert
 * or the movement import revert, which report the same progress shape. Any other kind of job is unavailable here. */
export async function GET(_request:Request,{params}:Params){
 const ctx=await requireAdmin();
 try{
  const row=await readBulkJob(ctx,(await params).jobId);
  if(row.kind===EMPLOYEE_IMPORT_REVERT_KIND)return Response.json({job:employeeImportRevertProgress(row)},{headers});
  if(row.kind===MOVEMENT_REVERT_KIND)return Response.json({job:movementImportRevertProgress(row)},{headers});
  throw new BulkJobError('Job unavailable.',404);
 }
 catch(error){
  if(error instanceof BulkJobError)return Response.json({error:'Revert unavailable.'},{status:error.status,headers});
  return Response.json({error:'The revert progress could not be read. Reopen this page.'},{status:500,headers});
 }
}
