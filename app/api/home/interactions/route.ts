import {getSession} from '@/lib/session';
import {AuthRequiredError} from '@/lib/auth-errors';
import {recordHomeCardInteractions} from '@/core/employee-home-analytics';
import {HomeAnalyticsInputError} from '@/lib/employee-home-analytics';
import {isSameOriginBrowserRequest} from '@/lib/request-origin';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
async function boundedBody(request:Request):Promise<unknown>{
 if(new URL(request.url).search||!isSameOriginBrowserRequest(request)
  ||!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??'')||!request.body)throw new HomeAnalyticsInputError();
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
  if(size>2048){await reader.cancel();throw new HomeAnalyticsInputError();}chunks.push(part.value);
 }}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const part of chunks){bytes.set(part,offset);offset+=part.byteLength;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new HomeAnalyticsInputError();}
}
export async function POST(request:Request){
 try{const session=await getSession(),body=await boundedBody(request);await recordHomeCardInteractions(session,body);
  return new Response(null,{status:204,headers});
 }catch(error){return Response.json({error:'unavailable'},{status:error instanceof AuthRequiredError?401:error instanceof HomeAnalyticsInputError?400:503,headers});}
}
