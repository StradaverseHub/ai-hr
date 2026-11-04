import {getSession} from '@/lib/session';
import {companyOrganisationRunReport} from '@/core/company-organisation';
import {toCsv} from '@/lib/csv';
export async function GET(request:Request){
 const s=await getSession(),id=new URL(request.url).searchParams.get('runId');if(!id||!/^[0-9a-f-]{36}$/i.test(id))return new Response('Unavailable',{status:404});
 // Re-admit every page. Frozen rows never change after publication; no wide employee export owner is used.
 const first=await companyOrganisationRunReport(s,id,0),encoder=new TextEncoder();
 const stream=new ReadableStream({async start(controller){try{
 controller.enqueue(encoder.encode('\uFEFF'+toCsv([['Run','Fingerprint','Effective date','State','Employment ID','Employee','Employee code','Company ID','Company','Employment status','Before tags','After tags','Before labels','After labels','Outcome','Exception']])));
 let report=first,offset=0;
 for(;;){controller.enqueue(encoder.encode(toCsv(report.rows.map(row=>[id,report.run.digest,report.run.effectiveOn,report.run.state,row.employmentId,row.employee,row.employeeCode,row.companyId,row.company,row.status,JSON.stringify(row.before),JSON.stringify(row.after),JSON.stringify(row.beforeDisplay),JSON.stringify(row.afterDisplay),row.outcome,row.reason]))));if(!report.hasMore)break;offset+=100;report=await companyOrganisationRunReport(s,id,offset);}
 controller.close();}catch(error){controller.error(error);}}});
 return new Response(stream,{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="organisation-run-${id}.csv"`,'Cache-Control':'private, no-store'}});
}
