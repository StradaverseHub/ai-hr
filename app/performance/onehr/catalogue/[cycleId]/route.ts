import { getSession } from '@/lib/session';
import { getOnehrCycle } from '@/packs/performance/service';
export async function GET(_request:Request,{params}:{params:Promise<{cycleId:string}>}) {
 const s=await getSession(),{cycleId}=await params,v=await getOnehrCycle(s,cycleId);
 if(!v)return new Response('Not found',{status:404});
 return new Response(JSON.stringify({framework:v.policy.framework,profiles:v.policy.profiles},null,2),{headers:{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="onehr-assessment-catalogue.json"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
