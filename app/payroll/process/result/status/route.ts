import {requireAdmin} from '@/lib/authz';
import {readRunGroup} from '@/core/payroll-run-group-store';
export const runtime='nodejs';
const headers={'Cache-Control':'private, no-store'};
/** The wizard run group's progress for the result screen's panel: each company's processing job while any runs,
 * and `done` once every company has its outcome. Only the group's creator can read it. */
export async function GET(request:Request){
 const ctx=await requireAdmin();
 const id=new URL(request.url).searchParams.get('g')??'';
 try{
  const view=await readRunGroup(ctx,id);
  if(view)return Response.json({done:view.done,companies:view.companies,worker:view.worker},{headers});
 }catch{/* an unreadable group is not found */}
 return Response.json({error:'Payroll run unavailable.'},{status:404,headers});
}
