import { isSameOriginBrowserRequest } from '@/lib/request-origin';
import { ZodError } from 'zod';
import { assertModuleEnabled } from '@/core/entitlements';
import { getSession } from '@/lib/session';
import { addTestingScreenshot } from '@/core/system-testing';
import { ModuleNotEnabledError } from '@/core/entitlements';
import { TestingRefusal,TESTING_LIMITS,testingUuid } from '@/lib/system-testing/model';
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}) {
  if(!isSameOriginBrowserRequest(request))return Response.json({error:'origin'},{status:403});
  const ctx=await getSession();
  try {
    assertModuleEnabled(ctx,'system_testing');
    const {id}=await params,runId=testingUuid.parse(new URL(request.url).searchParams.get('runId')); testingUuid.parse(id);
    const declared=request.headers.get('content-length'); if(declared&&(!/^\d+$/.test(declared)||Number(declared)>TESTING_LIMITS.screenshotBytes))return Response.json({error:'limit'},{status:413});
    const mimeType=request.headers.get('content-type')??'',encodedName=request.headers.get('x-file-name')??'';
    if(!request.body||encodedName.length>3000)throw new TestingRefusal('invalid');
    const reader=request.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
    try { for(;;) { const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.byteLength;if(bytes>TESTING_LIMITS.screenshotBytes){await reader.cancel();return Response.json({error:'limit'},{status:413});}chunks.push(chunk.value); } } finally { reader.releaseLock(); }
    let fileName:string;try{fileName=decodeURIComponent(encodedName);}catch{throw new TestingRefusal('invalid');}
    const saved=await addTestingScreenshot(ctx,{executionId:id,runId,fileName,mimeType,content:Buffer.concat(chunks)});
    return Response.json({id:saved.id},{status:201,headers:{'cache-control':'private, no-store'}});
  }catch(error){if(error instanceof ZodError)return Response.json({error:'invalid'},{status:400});if(error instanceof TestingRefusal)return Response.json({error:error.code},{status:409});if(error instanceof ModuleNotEnabledError)return Response.json({error:'module_unavailable'},{status:403});throw error;}
}
