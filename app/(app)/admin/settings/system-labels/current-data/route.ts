import { scopedAdmin } from '@/lib/scope';
import { downloadSystemLabelsWithData } from '@/core/system-label-import';
import { adminCompanies } from '@/core/read';
import { publicErrorMessage } from '@/lib/public-error';
export async function GET(request:Request){
 const {s}=await scopedAdmin();
 const q=new URL(request.url).searchParams;
 try{
  const companyIds=q.getAll('company'),kinds=q.getAll('kind');
  if(companyIds.length>1000||kinds.length>14)throw new Error('Selection exceeds the supported size.');
  const bytes=await downloadSystemLabelsWithData(s,{companyIds,kinds,includeInactive:q.get('inactive')==='1'});
  const stamp=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Kuala_Lumpur',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date()).replace(/[^0-9]/g,'');
  const companies=await adminCompanies(s),companyName=companies.find(c=>c.id===companyIds[0])?.name??'company';
  const slug=companyName.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80)||'company';
  const name=`system-labels_${companyIds.length===1?slug:'group'}_${stamp}.xlsx`;
  return new Response(new Uint8Array(bytes),{headers:{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','Content-Disposition':`attachment; filename="${name}"`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
 }catch(e){return Response.json({error:publicErrorMessage(e)},{status:400,headers:{'Cache-Control':'private, no-store'}});}
}
