import {requireAdmin} from '@/lib/authz';
import {getPayrollHistoryAttempt} from '@/packs/payroll/service';
import {toCsv} from '@/lib/csv';
export const runtime='nodejs';
export async function GET(_request:Request,{params}:{params:Promise<{attemptId:string}>}){
 const ctx=await requireAdmin(),{attemptId}=await params,item=await getPayrollHistoryAttempt(ctx,attemptId);
 if(!item)return new Response(null,{status:404});
 const rows:(string|number)[][]=[['Attempt','File','SHA-256','Company','Employee No','Period','Pay Cycle','Source Rows','Preview Outcome','Error','Before Values','Imported Values']];
 for(const row of item.plan.rows)rows.push([item.id,item.sourceName,item.sourceHash,row.companyName,row.employeeNo,row.period,row.cycleName,row.rowNums.join(', '),row.operation,row.reasons.join('\n'),JSON.stringify(row.beforeValues),JSON.stringify(row.values)]);
 for(const issue of item.plan.issues)rows.push([item.id,item.sourceName,item.sourceHash,'','','','',issue.rowNum,'invalid',issue.reason,'','']);
 rows.push([],['Event','Time','User','Detail']);
 for(const event of item.events)rows.push([event.kind,event.createdAt.toISOString(),event.actorId,JSON.stringify(event.detail)]);
 return new Response('\uFEFF'+toCsv(rows),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="payroll-history-${item.id}.csv"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
