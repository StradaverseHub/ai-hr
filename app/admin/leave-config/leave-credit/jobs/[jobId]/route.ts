import {requireAdmin} from '@/lib/authz';
import {readToilSweepJob} from '@/core/toil-sweep-job';
export const runtime='nodejs';
type Params={params:Promise<{jobId:string}>};
/** Progress of one background replacement-leave sweep (Process expirations, Close replacement-leave year), for the
 * person who started it; row security hides everyone else's. */
export async function GET(_request:Request,{params}:Params){
 const session=await requireAdmin();
 const job=await readToilSweepJob(session,(await params).jobId);
 if(!job)return Response.json({error:'Job unavailable.'},{status:404,headers:{'Cache-Control':'private, no-store'}});
 return Response.json({job},{headers:{'Cache-Control':'private, no-store'}});
}
