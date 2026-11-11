import {requireAdmin} from '@/lib/authz';
import {readLeaveImportJob} from '@/core/leave-import-job';
export const runtime='nodejs';
type Params={params:Promise<{jobId:string}>};
/** Progress of one background leave import, for the person who started it (row security hides everyone else's). */
export async function GET(_request:Request,{params}:Params){
 const session=await requireAdmin();
 const job=await readLeaveImportJob(session,(await params).jobId);
 if(!job)return Response.json({error:'Import unavailable.'},{status:404,headers:{'Cache-Control':'private, no-store'}});
 return Response.json({job},{headers:{'Cache-Control':'private, no-store'}});
}
