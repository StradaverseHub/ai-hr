import {requireAdmin} from '@/lib/authz';
import {importAttemptSource} from '@/core/import-history';
export const runtime='nodejs';
/** The original upload. Released only to an actor who can view every company named in the file. */
export async function GET(_request:Request,{params}:{params:Promise<{attemptId:string}>}){
 const ctx=await requireAdmin(),{attemptId}=await params,file=await importAttemptSource(ctx,attemptId);
 if(!file)return new Response(null,{status:404});
 return new Response(new Uint8Array(file.content),{headers:{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename="import-source"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/['()*]/g,char=>'%'+char.charCodeAt(0).toString(16))}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});
}
