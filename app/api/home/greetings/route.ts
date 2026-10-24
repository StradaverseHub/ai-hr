import {getSession} from '@/lib/session';
import {AuthRequiredError} from '@/lib/auth-errors';
import {HomeAccessError} from '@/core/employee-home';
import {sendHomeGreeting} from '@/core/employee-home-greetings';
import {HomeGreetingInputError} from '@/lib/employee-home-greeting';
import {isSameOriginBrowserRequest} from '@/lib/request-origin';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
async function commandBody(request:Request):Promise<unknown>{
 if(!isSameOriginBrowserRequest(request)||new URL(request.url).search
  ||!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??'')||!request.body)throw new HomeGreetingInputError();
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let total=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;
  if(total>4096){await reader.cancel();throw new HomeGreetingInputError();}chunks.push(value);
 }}finally{reader.releaseLock();}
 const bytes=new Uint8Array(total);let offset=0;
 for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new HomeGreetingInputError();}
}
export async function POST(request:Request){
 try{
  const session=await getSession(),command=await commandBody(request);
  return Response.json(await sendHomeGreeting(session,command),{headers});
 }catch(error){
  const code=error instanceof AuthRequiredError?'authentication':error instanceof HomeGreetingInputError?'invalid':error instanceof HomeAccessError?error.code:'unavailable';
  return Response.json({error:code},{status:code==='authentication'?401:code==='invalid'?400:code==='employmentUnavailable'?403:503,headers});
 }
}
