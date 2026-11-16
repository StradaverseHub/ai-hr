import {revalidatePath} from 'next/cache';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {isSameOriginBrowserRequest} from '@/lib/request-origin';
import {readBoundedBody,BodyReadError} from '@/lib/bounded-body';
import {PROBATION_FORM_MAX_BYTES} from '@/lib/probation-intake-html';
import {previewProbationSavedForm,importProbationSavedForm} from '@/packs/probation/service';
export const runtime='nodejs';
const headers={'cache-control':'private, no-store'};
/**
 * One saved evaluation form per request (handoff §5 Part C): `mode=preview` reads it on the server without writing;
 * `mode=import` reads it again and imports it in its own transaction. The page sends a batch of at most 50 files one by
 * one, so each request stays bounded to one 2 MB file and a bad file never blocks the others. The file is read as data
 * only (its JSON block); it is never rendered or executed.
 */
export async function POST(request:Request){
 const ctx=await requireScopedLifecycleModule();if(!isSameOriginBrowserRequest(request))return Response.json({ok:false},{status:403,headers});
 const type=request.headers.get('content-type');if(!type?.startsWith('multipart/form-data;'))return Response.json({ok:false},{status:400,headers});
 let form:FormData;
 try{const bytes=await readBoundedBody(request,PROBATION_FORM_MAX_BYTES+65536,20000,request.signal);form=await new Response(new Uint8Array(bytes).buffer,{headers:{'content-type':type}}).formData();}
 catch(error){return Response.json({ok:false},{status:error instanceof BodyReadError?413:400,headers});}
 const file=form.get('file'),companyId=form.get('company'),mode=form.get('mode');
 if(!(file instanceof File)||typeof companyId!=='string'||(mode!=='preview'&&mode!=='import')||file.name.length<1||file.name.length>200)return Response.json({ok:false},{status:400,headers});
 if(file.size>PROBATION_FORM_MAX_BYTES)return Response.json({ok:true,result:{file:file.name,result:'refused',code:'too_large',warnings:[]}},{headers});
 try{
  const input={companyId,name:file.name,content:Buffer.from(await file.arrayBuffer())};
  const result=mode==='preview'?await previewProbationSavedForm(ctx,input):await importProbationSavedForm(ctx,input);
  if(mode==='import'&&(result.result==='merged'||result.result==='staged'))revalidatePath('/lifecycle/probation','layout');
  return Response.json({ok:true,result},{headers});
 }catch{return Response.json({ok:false},{status:403,headers});}
}
