import {requirePayrollAccess} from '@/lib/authz';
import {readRunGroup} from '@/core/payroll-run-group-store';
import {payrollProgressReadFailed} from '@/lib/payroll-progress-poll';
export const runtime='nodejs';
const headers={'Cache-Control':'private, no-store'};
/** The wizard run group's progress for the result screen's panel: each company's processing job while any runs,
 * and `done` once every visible company has its outcome. A group the caller cannot see is not found; a read that
 * could not finish (for example the bounded Access-lock wait) is a 503 the panel retries (lib/payroll-progress-poll.ts). */
export async function GET(request:Request){
 const ctx=await requirePayrollAccess();
 const id=new URL(request.url).searchParams.get('g')??'';
 let view;
 try{view=await readRunGroup(ctx,id);}
 catch(error){return payrollProgressReadFailed('payroll run group status',error,headers);}
 if(view)return Response.json({done:view.done,companies:view.companies,worker:view.worker},{headers});
 return Response.json({error:'Payroll run unavailable.'},{status:404,headers});
}
