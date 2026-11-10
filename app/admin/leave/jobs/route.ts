import {requireAdmin} from '@/lib/authz';
import {activeLeaveCohortJob} from '@/core/leave-cohort-job';
import {LEAVE_ACCRUAL_JOB_KIND,LEAVE_GENERATION_JOB_KIND} from '@/lib/leave-cohort-job';
export const runtime='nodejs';
/** The caller's running leave processing job of one kind, so a screen can rejoin it after a reload. */
export async function GET(request:Request){
 const session=await requireAdmin();
 const kind=new URL(request.url).searchParams.get('kind');
 if(kind!==LEAVE_ACCRUAL_JOB_KIND&&kind!==LEAVE_GENERATION_JOB_KIND)return Response.json({error:'Unknown job.'},{status:400,headers:{'Cache-Control':'private, no-store'}});
 return Response.json({job:await activeLeaveCohortJob(session,kind)},{headers:{'Cache-Control':'private, no-store'}});
}
