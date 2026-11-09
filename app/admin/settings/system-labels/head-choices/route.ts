import {unstable_rethrow} from 'next/navigation';
import {requireAdmin} from '@/lib/authz';
import {isSameOriginBrowserRequest} from '@/lib/request-origin';
import {BodyReadError,readBoundedBody} from '@/lib/bounded-body';
import {AuthRequiredError} from '@/lib/auth-errors';
import {AiGatewayError} from '@/lib/ai/types';
import {labelMaintenanceHeadChoices,LabelHeadChoiceAccessError} from '@/core/system-labels';
import {LabelHeadChoiceInputError,parseLabelHeadChoiceInput} from '@/lib/system-label-head-choice';

export const runtime='nodejs';
const headers={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'};
/** The accepted packet is flat. Tokenize whole JSON strings so escaped quotes in
 * query values cannot masquerade as keys, and reject repeated (also escaped) keys. */
function parsePacket(bytes:Uint8Array){
 const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes),raw:unknown=JSON.parse(text);
 const input=parseLabelHeadChoiceInput(raw),keys=new Set<string>();
 for(const token of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"/g)){
  if(text.slice(token.index+token[0].length).trimStart()[0]!==':')continue;
  const key:string=JSON.parse(token[0]);if(keys.has(key))throw new LabelHeadChoiceInputError();keys.add(key);
 }
 return input;
}
/** Navigation-only POST: no lookup text/selected identity is put in URL or persisted draft state. */
export async function POST(request:Request){
 const site=request.headers.get('sec-fetch-site');
 if(!isSameOriginBrowserRequest(request)||site!==null&&site!=='same-origin'||request.headers.has('authorization'))return Response.json({error:'forbidden'},{status:403,headers});
 try{
  if(new URL(request.url).search||!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))throw new LabelHeadChoiceInputError();
  const session=await requireAdmin();
  const bytes=await readBoundedBody(request,8192,5000,request.signal);
  let input:ReturnType<typeof parsePacket>;try{input=parsePacket(bytes);}catch{throw new LabelHeadChoiceInputError();}
  return Response.json(await labelMaintenanceHeadChoices(session,input,request.signal),{headers});
 }catch(error){
  unstable_rethrow(error);if(request.signal.aborted)throw error;
  const status=error instanceof AuthRequiredError?401:error instanceof BodyReadError||error instanceof LabelHeadChoiceInputError?400:
   error instanceof LabelHeadChoiceAccessError||error instanceof AiGatewayError?403:503;
  return Response.json({error:status===401?'authentication':status===400?'invalid':status===403?'forbidden':'unavailable'},{status,headers});
 }
}
