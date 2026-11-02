import {revalidatePath} from 'next/cache';
import {requireScopedLifecycleModule} from '@/lib/scoped-lifecycle-page';
import {isSameOriginBrowserRequest} from '@/lib/request-origin';
import {readBoundedBody,BodyReadError} from '@/lib/bounded-body';
import {uploadProbationCutoverEvidence} from '@/packs/probation/service';
export const runtime='nodejs';
const headers={'cache-control':'private, no-store'},MAX=10*1024*1024;
export async function POST(request:Request,{params}:{params:Promise<{employmentId:string}>}){
 const ctx=await requireScopedLifecycleModule();if(!isSameOriginBrowserRequest(request))return Response.json({ok:false},{status:403,headers});
 const{employmentId}=await params,type=request.headers.get('content-type');if(!type?.startsWith('multipart/form-data;'))return Response.json({ok:false},{status:400,headers});
 try{const bytes=await readBoundedBody(request,MAX+65536,20000,request.signal),form=await new Response(new Uint8Array(bytes).buffer,{headers:{'content-type':type}}).formData(),file=form.get('file'),reason=form.get('reason');
 if(!(file instanceof File)||file.size<1||file.size>MAX||typeof reason!=='string'||reason.trim().length<3||reason.length>5000)return Response.json({ok:false},{status:400,headers});
 const id=await uploadProbationCutoverEvidence(ctx,{employmentId,name:file.name,content:Buffer.from(await file.arrayBuffer()),reason});revalidatePath('/lifecycle/probation/intake');return Response.json({ok:true,id},{headers});
 }catch(error){return Response.json({ok:false},{status:error instanceof BodyReadError?413:400,headers});}
}
