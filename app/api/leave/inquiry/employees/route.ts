import {capacityAwareRoute} from '@/lib/database-degraded';
import {getLocale} from 'next-intl/server';
import {scopedSession} from '@/lib/scope';
import {AuthRequiredError} from '@/lib/auth-errors';
import {readLeaveInquiryPicker} from '@/packs/leave/service';
import {InquiryQueryError} from '@/lib/leave-inquiry-query';
import {isSameOriginBrowserRequest} from '@/lib/request-origin';
import {normalizeLeaveInquiryPicker} from '@/lib/leave-inquiry-picker';
import type {EmployeeChoiceInput} from '@/lib/employee-choice';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
async function body(request:Request):Promise<EmployeeChoiceInput>{
 if(new URL(request.url).search||!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??'')||!request.body)throw new InquiryQueryError('Invalid body');
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
  if(size>16384){await reader.cancel();throw new InquiryQueryError('Invalid body');}chunks.push(part.value);
 }}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new InquiryQueryError('Invalid body');}
 if(!value||typeof value!=='object'||Array.isArray(value))throw new InquiryQueryError('Invalid body');
 normalizeLeaveInquiryPicker(value as EmployeeChoiceInput);return value as EmployeeChoiceInput;
}
/** Navigation read only. Native HR admission intersects current company context afresh. */
export const POST = capacityAwareRoute(async function POST(request:Request){
 if(!isSameOriginBrowserRequest(request))return Response.json({error:'origin'},{status:403,headers});
 try{
  const input=await body(request),{s,scopeIds}=await scopedSession(),locale=await getLocale();
  return Response.json(await readLeaveInquiryPicker(s,scopeIds,input,locale,request.signal),{headers});
 }catch(error){
  const status=error instanceof AuthRequiredError?401:error instanceof InquiryQueryError?error.message==='Forbidden'?403:400:503;
  return Response.json({error:status===401?'authentication':status===400?'invalid':status===403?'forbidden':'unavailable'},{status,headers});
 }
});
