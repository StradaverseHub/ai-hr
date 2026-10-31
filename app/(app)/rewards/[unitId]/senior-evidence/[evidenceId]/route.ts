import { getSession } from '@/lib/session';
import { readRewardSeniorEvidence } from '@/packs/rewards/service';
export async function GET(_request:Request,{params}:{params:Promise<{unitId:string;evidenceId:string}>}){
 const {unitId,evidenceId}=await params;
 try{const file=await readRewardSeniorEvidence(await getSession(),unitId,evidenceId);return new Response(Buffer.from(file.content,'base64'),{headers:{'Content-Type':file.mime,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});}
 catch{return new Response('Evidence unavailable.',{status:404});}
}
