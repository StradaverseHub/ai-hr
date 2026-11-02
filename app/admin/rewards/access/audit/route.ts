import {getSession} from '@/lib/session';
import {getScopeIds} from '@/lib/scope';
import {rewardAccessCompanies,rewardAccessAdministration,rewardAccessRequests} from '@/packs/rewards/service';
import {toCsv} from '@/lib/csv';
export async function GET(){
 const session=await getSession(),scope=await getScopeIds((await rewardAccessCompanies(session)).map(c=>c.id));
 const value=await rewardAccessAdministration(session,scope),allowed=new Set(value.reviews.map(r=>r.id));
 const requests=(await rewardAccessRequests(session,{audit:true})).filter(q=>q.changes.every(c=>allowed.has(c.unitId)));
 const rows=requests.flatMap(q=>q.changes.flatMap(c=>{
  const review=value.reviews.find(r=>r.id===c.unitId)!;
  const shared=[q.id,c.unitId,review.company,review.unit,q.requestedBy,JSON.stringify(c.before),JSON.stringify(c.after)];
  return [[...shared,'requested',q.requestedAt,'',q.requestReason??'',''],...(q.decidedAt?[[...shared,q.status,q.decidedAt,q.decidedBy??'',q.reason??'',q.exemptionBasis?.[c.unitId]??'']]:[])];
 }));
 return new Response('\uFEFF'+toCsv([['Request','Review','Company','Business unit','Requester','Before','After','Event','Time','Independent approver','Reason','Exemption basis'],...rows]),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="rewards-access-audit.csv"','Cache-Control':'private, no-store'}});
}
