import {getSession} from '@/lib/session';
import {getScopeIds} from '@/lib/scope';
import {adminCompanies} from '@/core/read';
import {rewardRoleLabels,rewardAccessAdministration} from '@/packs/rewards/service';
import {toCsv} from '@/lib/csv';
/** Same live company/member authority as the screen, no pay roster, and formula-safe CSV cells. */
export async function GET(){
 const session=await getSession(),companies=await adminCompanies(session),scope=await getScopeIds(companies.map(company=>company.id));
 const value=await rewardAccessAdministration(session,scope);
 const rows=value.members.map(member=>{
  const review=value.reviews.find(review=>review.id===member.unitId)!;
  return [member.name??member.email??'',rewardRoleLabels[member.role],review.company,review.unit,review.cycle,review.year,review.status,member.validFrom,member.validTo,member.suspension?.reason??(member.disabled?'login':'active'),member.suspension?.on,member.coversUserId?(value.users.find(user=>user.id===member.coversUserId)?.name??value.members.find(other=>other.userId===member.coversUserId)?.name??'Unavailable'):'',member.lastChangedAt];
 });
 return new Response('\uFEFF'+toCsv([['Person','Role','Company','Business unit','Review cycle','Year','Review status','From','Until','Access status','Status changed on','Proxy for','Last change'],...rows]),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="rewards-access.csv"','Cache-Control':'private, no-store'}});
}
