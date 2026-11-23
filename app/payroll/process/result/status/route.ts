import {requirePayrollAccess} from '@/lib/authz';
import {readRunGroup} from '@/core/payroll-run-group-store';
import {pgSqlState} from '@/lib/db-error';
import {isDatabaseCapacityFailure} from '@/db/read-retry';
import {DATABASE_RETRY_AFTER_SECONDS} from '@/lib/database-capacity';
export const runtime='nodejs';
const headers={'Cache-Control':'private, no-store'};
/** A bounded Access wait that ran out (55P03) or a database without capacity: the run is still there, the
 * read just could not start yet. Production, 23 November 2026: while a tax-basis recalculation held the
 * Access lock, every poll for 25 s answered "Payroll run unavailable." although nothing was wrong with it. */
function isRunGroupBusy(error:unknown){return pgSqlState(error)==='55P03'||isDatabaseCapacityFailure(error);}
/** The wizard run group's progress for the result screen's panel: each company's processing job while any runs,
 * and `done` once every visible company has its outcome. A busy read answers 503 so the panel keeps polling
 * quietly; only a group that cannot be read answers 404. */
export async function GET(request:Request){
 const ctx=await requirePayrollAccess();
 const id=new URL(request.url).searchParams.get('g')??'';
 try{
  const view=await readRunGroup(ctx,id);
  if(view)return Response.json({done:view.done,companies:view.companies,worker:view.worker},{headers});
 }catch(error){
  if(isRunGroupBusy(error))return Response.json({busy:true},{status:503,headers:{...headers,'Retry-After':String(DATABASE_RETRY_AFTER_SECONDS)}});
  /* any other unreadable group is not found */
 }
 return Response.json({error:'Payroll run unavailable.'},{status:404,headers});
}
