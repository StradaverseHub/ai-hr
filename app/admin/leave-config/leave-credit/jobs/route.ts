import {requireAdmin} from '@/lib/authz';
import {activeToilSweepJob} from '@/core/toil-sweep-job';
import {isToilSweepJobKind} from '@/lib/toil-sweep-job';
export const runtime='nodejs';
/** The caller's running replacement-leave sweep of one kind, so a screen can rejoin it after a reload. */
export async function GET(request:Request){
 const session=await requireAdmin();
 const kind=new URL(request.url).searchParams.get('kind');
 if(!isToilSweepJobKind(kind))return Response.json({error:'Unknown job.'},{status:400,headers:{'Cache-Control':'private, no-store'}});
 return Response.json({job:await activeToilSweepJob(session,kind)},{headers:{'Cache-Control':'private, no-store'}});
}
