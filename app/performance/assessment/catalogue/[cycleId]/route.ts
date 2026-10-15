import { getSession } from '@/lib/session';
import { getOnehrCycle } from '@/packs/performance/service';
export async function GET(_request:Request,{params}:{params:Promise<{cycleId:string}>}) {
 const s=await getSession(),{cycleId}=await params,v=await getOnehrCycle(s,cycleId);
 if(!v)return new Response('Not found',{status:404});
 return new Response(JSON.stringify({framework:v.policy.framework,leadershipPrinciples:v.policy.leadershipPrinciples,profiles:v.policy.profiles,skills:v.policy.skills??[],careerRoutes:v.policy.careerRoutes??[]},null,2),{headers:{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="assessment-catalogue.json"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
