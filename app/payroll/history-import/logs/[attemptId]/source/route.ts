import {requireAdmin} from '@/lib/authz';
import {payrollHistorySource} from '@/packs/payroll/service';
export const runtime='nodejs';
export async function GET(_request:Request,{params}:{params:Promise<{attemptId:string}>}){
 const ctx=await requireAdmin(),{attemptId}=await params,source=await payrollHistorySource(ctx,attemptId);
 if(!source)return new Response(null,{status:404});
 return new Response(new Uint8Array(source.content),{headers:{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="payroll-history-source"; filename*=UTF-8''${encodeURIComponent(source.name).replace(/['()*]/g,char=>'%'+char.charCodeAt(0).toString(16))}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
