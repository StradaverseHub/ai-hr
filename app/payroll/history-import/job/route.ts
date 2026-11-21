import {requireAdmin} from '@/lib/authz';
import {payrollHistoryJobStatus} from '@/packs/payroll/service';
export const runtime='nodejs';
const headers={'Cache-Control':'private, no-store'};
/** The signed-in creator's payroll history confirm or revert job, for the screen's progress panel. */
export async function GET(request:Request){
 const ctx=await requireAdmin();
 try{
  const status=await payrollHistoryJobStatus(ctx,new URL(request.url).searchParams.get('id')??'');
  if(status)return Response.json(status,{headers});
 }catch{/* an unreadable job is not found */}
 return Response.json({error:'Job unavailable.'},{status:404,headers});
}
