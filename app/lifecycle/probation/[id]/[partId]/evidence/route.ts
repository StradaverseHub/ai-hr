import {revalidatePath} from 'next/cache';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {isSameOriginBrowserRequest} from '@/lib/request-origin';
import {readBoundedBody,BodyReadError} from '@/lib/bounded-body';
import {uploadProbationEvidence} from '@/packs/probation/service';
export const runtime='nodejs';
const headers={'cache-control':'private, no-store'},MAX=10*1024*1024;
export async function POST(request:Request,{params}:{params:Promise<{id:string;partId:string}>}){
 const ctx=await requireScopedLifecycleModule();if(!isSameOriginBrowserRequest(request))return Response.json({ok:false},{status:403,headers});
 const {id,partId}=await params,type=request.headers.get('content-type');if(!type?.startsWith('multipart/form-data;'))return Response.json({ok:false},{status:400,headers});
 try{
  const bytes=await readBoundedBody(request,MAX+65536,20000,request.signal),form=await new Response(bytes,{headers:{'content-type':type}}).formData();
  const file=form.get('file'),revision=Number(form.get('revision')),reason=form.get('reason');
  if(!(file instanceof File)||file.size<1||file.size>MAX||!Number.isSafeInteger(revision)||revision<1||typeof reason!=='string'||!reason.trim()||reason.length>5000)return Response.json({ok:false},{status:400,headers});
  const result=await uploadProbationEvidence(ctx,{caseId:id,partId,revision,name:file.name,content:Buffer.from(await file.arrayBuffer()),reason});
  revalidatePath('/lifecycle/probation','layout');return Response.json({ok:true,id:result},{headers});
 }catch(error){return Response.json({ok:false},{status:error instanceof BodyReadError?413:400,headers});}
}
