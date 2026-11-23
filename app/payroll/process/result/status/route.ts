import {requirePayrollAccess} from '@/lib/authz';
import {readRunGroup} from '@/core/payroll-run-group-store';
import {isPayrollProgressBusy,payrollProgressBusy} from '@/lib/payroll-progress-poll.server';
export const runtime='nodejs';
const headers={'Cache-Control':'private, no-store'};
/** The wizard run group's progress for the result screen's panel: each company's processing job while any runs,
 * and `done` once every visible company has its outcome. A busy read (the bounded Access wait ran out, or the
 * database had no capacity) answers 503 so the panel keeps polling quietly (lib/payroll-progress-poll.server.ts); only a
 * group that cannot be read answers 404. Production, 23 November 2026: while a tax-basis recalculation held the
 * Access lock, every poll for 25 s answered "Payroll run unavailable." although nothing was wrong with it. */
export async function GET(request:Request){
 const ctx=await requirePayrollAccess();
 const id=new URL(request.url).searchParams.get('g')??'';
 try{
  const view=await readRunGroup(ctx,id);
  if(view)return Response.json({done:view.done,companies:view.companies,worker:view.worker},{headers});
 }catch(error){
  if(isPayrollProgressBusy(error))return payrollProgressBusy('payroll run group status',error,headers);
  /* any other unreadable group is not found */
 }
 return Response.json({error:'Payroll run unavailable.'},{status:404,headers});
}
