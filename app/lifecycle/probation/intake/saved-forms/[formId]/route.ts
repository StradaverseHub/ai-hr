import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {readProbationFormImport} from '@/packs/probation/service';
export const runtime='nodejs';
// The original saved form is hostile data: it is only ever downloaded, never rendered (octet-stream, attachment,
// nosniff and a sandboxing policy in case a browser opens it anyway).
const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff','content-security-policy':"sandbox; default-src 'none'"};
export async function GET(_request:Request,{params}:{params:Promise<{formId:string}>}){
 const ctx=await requireScopedLifecycleModule(),{formId}=await params;
 try{const file=await readProbationFormImport(ctx,formId);return new Response(new Uint8Array(file.content),{headers:{...headers,'content-type':'application/octet-stream','content-disposition':"attachment; filename=\"saved-probation-form.html\"; filename*=UTF-8''"+encodeURIComponent(file.name)}});}
 catch{return new Response(null,{status:404,headers});}
}
