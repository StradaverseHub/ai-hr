import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {readProbationCutoverEvidence} from '@/packs/probation/service';
export const runtime='nodejs';
const headers={'cache-control':'private, no-store','x-content-type-options':'nosniff'};
export async function GET(_request:Request,{params}:{params:Promise<{employmentId:string;evidenceId:string}>}){
 const ctx=await requireScopedLifecycleModule(),{employmentId,evidenceId}=await params;
 try{const file=await readProbationCutoverEvidence(ctx,{employmentId,evidenceId});return new Response(new Uint8Array(file.content),{headers:{...headers,'content-type':'application/pdf','content-disposition':"attachment; filename=\"offline-probation.pdf\"; filename*=UTF-8''"+encodeURIComponent(file.name)}});}
 catch{return new Response(null,{status:404,headers});}
}
