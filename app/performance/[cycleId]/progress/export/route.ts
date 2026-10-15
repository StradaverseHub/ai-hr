import { getSession } from '@/lib/session';
import { exportAssessmentProgress,exportAssessmentAssessorProgress } from '@/packs/performance/service';
export async function GET(request:Request,{params}:{params:Promise<{cycleId:string}>}){
 const s=await getSession(),{cycleId}=await params,q=new URL(request.url).searchParams,assessors=q.get('kind')==='assessors';
 const raw=Object.fromEntries(['module','state','q','companyId','company','department','businessGroup'].flatMap(k=>q.has(k)?[[k,q.get(k)]]:[]));
 const csv=assessors?await exportAssessmentAssessorProgress(s,cycleId,raw):await exportAssessmentProgress(s,cycleId,raw);
 return new Response('\uFEFF'+csv,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${assessors?'assessor':'assessment'}-progress.csv"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
