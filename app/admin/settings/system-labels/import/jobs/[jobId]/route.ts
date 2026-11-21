import {scopedAdmin} from '@/lib/scope';
import {getSystemLabelImportJob,SystemLabelImportJobError} from '@/core/system-label-import-job';
export const runtime='nodejs';
type Params={params:Promise<{jobId:string}>};
/** One import's progress, readable only by its creator while their access lasts (bulk_job row security). */
export async function GET(_request:Request,{params}:Params){
  const {s}=await scopedAdmin();
  try{return Response.json({job:await getSystemLabelImportJob(s,(await params).jobId)},{headers:{'Cache-Control':'private, no-store'}});}
  catch(error){const status=error instanceof SystemLabelImportJobError?error.status:404;return Response.json({error:'Import unavailable.'},{status:status===400?404:status,headers:{'Cache-Control':'private, no-store'}});}
}
