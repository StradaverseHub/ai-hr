import { getSession } from '@/lib/session';
import { exportAssessmentRatingRecords, buildRatingRecordWorkbook } from '@/packs/performance/service';
export async function GET(request:Request,{params}:{params:Promise<{cycleId:string}>}){
 const s=await getSession(),{cycleId}=await params,q=new URL(request.url).searchParams;
 const data=await exportAssessmentRatingRecords(s,cycleId,{company:q.get('company')??undefined,department:q.get('department')??undefined,businessGroup:q.get('businessGroup')??undefined});
 const bytes=buildRatingRecordWorkbook(data);
 return new Response(new Uint8Array(bytes),{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':'attachment; filename="performance-rating-records.xlsx"','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
