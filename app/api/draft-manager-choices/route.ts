import {capacityAwareRoute} from '@/lib/database-degraded';
import {scopedSession} from '@/lib/scope';
import {AuthRequiredError} from '@/lib/auth-errors';
import {draftManagerChoices} from '@/core/draft-manager-choice';
import {workforceChoiceInput,WorkforceChoiceInputError,WorkforceChoiceAccessError,type WorkforceChoiceInput} from '@/lib/workforce-choice';
import {isSameOriginBrowserRequest} from '@/lib/request-origin';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
async function body(request:Request):Promise<WorkforceChoiceInput>{
 if(new URL(request.url).search||!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??'')||!request.body)throw new WorkforceChoiceInputError();
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
  if(size>16384){await reader.cancel();throw new WorkforceChoiceInputError();}chunks.push(part.value);
 }}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new WorkforceChoiceInputError();}
 if(!value||typeof value!=='object'||Array.isArray(value))throw new WorkforceChoiceInputError();
 return workforceChoiceInput(value);
}
/** Read-only POST keeps raw employee search out of URLs and access logs. The draft owner and employment/person RLS own scope. */
export const POST=capacityAwareRoute(async function POST(request:Request){
 if(!isSameOriginBrowserRequest(request))return Response.json({error:'origin'},{status:403,headers});
 try{
  const {s,scopeIds}=await scopedSession();
  return Response.json(await draftManagerChoices(s,scopeIds,await body(request)),{headers});
 }catch(error){
  const status=error instanceof AuthRequiredError?401:error instanceof WorkforceChoiceInputError?400:error instanceof WorkforceChoiceAccessError?403:503;
  return Response.json({error:status===401?'authentication':status===400?'invalid':status===403?'forbidden':'unavailable'},{status,headers});
 }
});
