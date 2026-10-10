import { resolveMyTeamScope } from '@/core/my-team-scope';
import { myTeamLeaveProjection } from '@/packs/leave/service';
import { hasTeamAccess } from '@/lib/authz';
import { TeamResponse } from '@/lib/mobile-api/contract';
import { mobileRoute } from '@/lib/mobile-api/handler';
import { todayInKualaLumpur } from '@/lib/hr-date';
/** No caller-supplied team, company or employment list is accepted. My Team owns membership. */
export const GET = mobileRoute(TeamResponse,async(s)=>{
  const today=todayInKualaLumpur();
  const through=new Date(Date.parse(today+'T00:00:00Z')+6*86400000).toISOString().slice(0,10);
  if(!hasTeamAccess(s))return {enabled:false,today,through,items:[]};
  const scope=await resolveMyTeamScope(s,{view:'week',scope:'all'});
  const rows=await myTeamLeaveProjection({...s,personId:scope.principal.personId},{employmentIds:scope.employees.map(e=>e.employmentId),from:today,to:through,today});
  return {enabled:true,today,through,items:scope.employees.map(e=>({employmentId:e.employmentId,name:e.name,dates:rows.filter(r=>r.employmentId===e.employmentId).flatMap(r=>r.dates.filter(d=>d.date>=today&&d.date<=through).map(d=>({date:d.date,status:d.status,session:r.session})))}))};
});
