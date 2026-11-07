import {scopedSession} from '@/lib/scope';
import {AuthRequiredError} from '@/lib/auth-errors';
import {readEmployeeChoices,EmployeeChoiceInputError,EmployeeChoiceAccessError} from '@/core/employee-choice';
import {isSameOriginBrowserRequest} from '@/lib/request-origin';
import type {EmployeeChoiceInput} from '@/lib/employee-choice';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff'};
async function body(request:Request):Promise<EmployeeChoiceInput>{
 if(new URL(request.url).search||!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??'')||!request.body)throw new EmployeeChoiceInputError();
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;
  if(size>16384){await reader.cancel();throw new EmployeeChoiceInputError();}chunks.push(part.value);
 }}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
 let value:unknown;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw new EmployeeChoiceInputError();}
 if(!value||typeof value!=='object'||Array.isArray(value))throw new EmployeeChoiceInputError();
 const input=value as Record<string,unknown>,strings=['query','companyId','businessUnitId','departmentId','status','selectedId','labelMode'],numbers=['offset','limit'];
 if(Object.keys(input).some(key=>!strings.includes(key)&&!numbers.includes(key))
  ||strings.some(key=>key in input&&typeof input[key]!=='string')||numbers.some(key=>key in input&&typeof input[key]!=='number'))throw new EmployeeChoiceInputError();
 return input as EmployeeChoiceInput;
}
/** POST is a side-effect-free read: raw search stays out of URLs and access logs. */
export async function POST(request:Request){
 if(!isSameOriginBrowserRequest(request))return Response.json({error:'origin'},{status:403,headers});
 try{
  const {s,scopeIds}=await scopedSession();
  const input=await body(request);
  const value=await readEmployeeChoices(s,{...input,companyIds:scopeIds},request.signal);
  return Response.json(value,{headers});
 }catch(error){
  const status=error instanceof AuthRequiredError?401:error instanceof EmployeeChoiceInputError?400:error instanceof EmployeeChoiceAccessError?403:503;
  return Response.json({error:status===401?'authentication':status===400?'invalid':status===403?'forbidden':'unavailable'},{status,headers});
 }
}
