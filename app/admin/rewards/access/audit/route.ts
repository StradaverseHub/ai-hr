import {rewardAccessPageCompanies} from '@/packs/rewards/access-policy';
import {getSession} from '@/lib/session';
import {getScopeIds} from '@/lib/scope';
import {rewardAccessCompanies,rewardAccessAdministration,rewardAccessRequests} from '@/packs/rewards/service';
import {toCsv} from '@/lib/csv';
import {rewardRolePermissionAuditRows} from '@/packs/rewards/role-permission-grid';
export async function GET(){
 const session=await getSession(),scope=await getScopeIds((await rewardAccessPageCompanies(session,true)).map(c=>c.id));
 const value=await rewardAccessAdministration(session,scope),allowed=new Set(value.reviews.map(r=>r.id));
 const requests=(await rewardAccessRequests(session,{audit:true})).filter(q=>q.changes.every(c=>allowed.has(c.unitId)));
 const rows=requests.flatMap(q=>q.changes.flatMap(c=>{
  const review=value.reviews.find(r=>r.id===c.unitId)!;
  const shared=[q.id,c.unitId,review.company,review.unit,q.requestedBy,JSON.stringify(c.before),JSON.stringify(c.after)];
  return [[...shared,'requested',q.requestedAt,'',q.requestReason??'',''],...(q.decidedAt?[[...shared,q.status,q.decidedAt,q.decidedBy??'',q.reason??'',q.exemptionBasis?.[c.unitId]??'']]:[])];
 }));
 // Board db14e49c: role permission batches (saved, waiting, decided) and the earlier one-cell changes.
 const permissionRows=await rewardRolePermissionAuditRows(session);
 return new Response('\uFEFF'+toCsv([['Request','Review','Company','Business unit','Requester','Before','After','Event','Time','Independent approver','Reason','Exemption basis'],...rows,...permissionRows]),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="rewards-access-audit.csv"','Cache-Control':'private, no-store'}});
}
