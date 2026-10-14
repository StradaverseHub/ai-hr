import { getSession } from '@/lib/session';
import { exportAssessmentFinalBands } from '@/packs/performance/service';
export async function GET(_request:Request,{params}:{params:Promise<{sessionId:string}>}) {
 const s=await getSession(),{sessionId}=await params;
 return new Response(await exportAssessmentFinalBands(s,sessionId),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="performance-final-bands.csv"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
