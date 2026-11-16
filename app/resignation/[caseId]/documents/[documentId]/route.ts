import {getSession} from '@/lib/session';
import {downloadResignationLetter} from '@/packs/lifecycle/resignation/service';
export async function GET(_request:Request,{params}:{params:Promise<{caseId:string;documentId:string}>}){
 try{const {caseId,documentId}=await params;const result=await downloadResignationLetter(await getSession(),{caseId,documentId});const name=result.name.replace(/[\r\n"\\/]/g,'_'),fallback=name.replace(/[^\x20-\x7e]/g,'_');return new Response(new Uint8Array(result.content),{headers:{'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g,c=>'%'+c.charCodeAt(0).toString(16))}`,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}});}catch(error){if(error&&typeof error==='object'&&'code'in error&&(error.code==='forbidden'||error.code==='not_found'))return new Response(null,{status:404});throw error;}
}
