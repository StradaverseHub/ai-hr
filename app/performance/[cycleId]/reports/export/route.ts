import {getSession} from '@/lib/session';
import {exportAssessmentAdminReport,assessmentAdminReportCsv,buildAssessmentAdminWorkbook} from '@/packs/performance/service';
export async function GET(request:Request,{params}:{params:Promise<{cycleId:string}>}){
 const s=await getSession(),{cycleId}=await params,q=new URL(request.url).searchParams,format=q.get('format')??'xlsx';
 if(!['csv','xlsx'].includes(format))return new Response('Choose CSV or Excel.',{status:400});q.delete('format');
 const report=await exportAssessmentAdminReport(s,cycleId,Object.fromEntries(q)),body=format==='csv'?assessmentAdminReportCsv(report):new Uint8Array(buildAssessmentAdminWorkbook(report));
 return new Response(body,{headers:{'Content-Type':format==='csv'?'text/csv; charset=utf-8':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="performance-report.${format}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
