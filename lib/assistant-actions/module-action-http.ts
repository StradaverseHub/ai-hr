/** Strict human browser transport. No model tools, posted actor, source receipt or executor. */
import {z} from 'zod';
import {ModuleActionPrepare,ModuleActionConfirmation,ModuleActionPreparedReview,ModuleActionCompletedReceipt,ModuleActionRetiredReceipt,ModuleActionReviewIndexResult} from './module-action-review-contract';
export const ModuleActionBrowserPacket=z.discriminatedUnion('operation',[
 z.object({operation:z.literal('list')}).strict(),
 z.object({operation:z.literal('prepare'),input:ModuleActionPrepare}).strict(),
 z.object({operation:z.literal('reopen'),actionId:z.uuid()}).strict(),
 z.object({operation:z.literal('confirm'),confirmation:ModuleActionConfirmation}).strict(),
 z.object({operation:z.literal('discard'),confirmation:ModuleActionConfirmation}).strict(),
]);
export type ModuleActionBrowserPacket=z.infer<typeof ModuleActionBrowserPacket>;
export const ModuleActionBrowserResult=z.discriminatedUnion('kind',[
 ModuleActionReviewIndexResult,
 z.object({kind:z.literal('prepared'),review:ModuleActionPreparedReview}).strict(),
 z.object({kind:z.literal('completed'),receipt:ModuleActionCompletedReceipt}).strict(),
 z.object({kind:z.literal('retired'),receipt:ModuleActionRetiredReceipt}).strict(),
]);
export type ModuleActionBrowserResult=z.infer<typeof ModuleActionBrowserResult>;
export const ModuleActionBrowserError=z.object({error:z.literal('unavailable')}).strict();
export function parseModuleActionBrowserResult(operation:ModuleActionBrowserPacket['operation'],value:unknown):ModuleActionBrowserResult{
 const result=ModuleActionBrowserResult.parse(value);
 const allowed=operation==='list'?result.kind==='module_review_index':operation==='prepare'?result.kind==='prepared':operation==='confirm'?result.kind==='completed'||result.kind==='retired':operation==='discard'?result.kind==='retired':result.kind!=='module_review_index';
 if(!allowed)throw Error('Module action response unavailable.');return result;
}
export type ModuleActionBrowserOwners<Session>=Readonly<{
 authenticate():Promise<Session>;
 list(session:Session):Promise<unknown>;
 prepare(session:Session,input:z.infer<typeof ModuleActionPrepare>):Promise<unknown>;
 reopen(session:Session,actionId:string):Promise<unknown>;
 confirm(session:Session,input:z.infer<typeof ModuleActionConfirmation>):Promise<unknown>;
 discard(session:Session,input:z.infer<typeof ModuleActionConfirmation>):Promise<unknown>;
}>;
const responseHeaders={'Cache-Control':'private, no-store','Vary':'Cookie, Authorization','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const unavailable=(status:number)=>Response.json({error:'unavailable'},{status,headers:responseHeaders});
/** Fixed byte/fragment/time bounds before identity/source work. Once confirmation starts, transport
 * loss is uncertain; the client must reopen the SAME saved action rather than create/retry effects. */
async function packet(request:Request):Promise<ModuleActionBrowserPacket>{
 const length=request.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||!Number.isSafeInteger(Number(length))||Number(length)>20480))throw Error();
 if(!request.body||request.signal.aborted)throw Error();
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let bytes=0,fragments=0,rejectAbort!:()=>void;
 const stopped=new Promise<never>((_,reject)=>{rejectAbort=()=>reject(Error());});void stopped.catch(()=>{});
 const abort=()=>{rejectAbort();void reader.cancel().catch(()=>{});};request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();const timer=setTimeout(abort,5000);
 try{for(;;){if(++fragments>512)throw Error();const part=await Promise.race([reader.read(),stopped]);if(part.done)break;bytes+=part.value.byteLength;if(bytes>20480)throw Error();chunks.push(part.value);}
  if(request.signal.aborted)throw Error();const body=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
  return ModuleActionBrowserPacket.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body)));
 }catch{void reader.cancel().catch(()=>{});throw Error();}finally{clearTimeout(timer);request.signal.removeEventListener('abort',abort);reader.releaseLock();}
}
/** Trusted server construction only. Undefined/invalid configured origins refuse; request Host,
 * Forwarded and URL never become an origin allow-list. No same-URL fallback or bearer caller. */
export function createModuleActionBrowserHandler<Session>(owners:ModuleActionBrowserOwners<Session>,policy:Readonly<{publicOrigin:string|undefined}>){
 const configured=policy.publicOrigin;
 return async(request:Request):Promise<Response>=>{
  if(request.method!=='POST')return unavailable(405);
  try{const origin=configured?new URL(configured):null;if(!origin||!['https:','http:'].includes(origin.protocol)||origin.origin!==configured||request.headers.get('origin')!==configured||request.headers.has('authorization')||new URL(request.url).search)return unavailable(403);}catch{return unavailable(403);}
  const site=request.headers.get('sec-fetch-site');if(site!==null&&site!=='same-origin')return unavailable(403);
  if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))return unavailable(415);
  let input:ModuleActionBrowserPacket;try{input=await packet(request);}catch{return unavailable(400);}
  let session:Session;try{session=await owners.authenticate();}catch{return unavailable(401);}
  if(request.signal.aborted)return unavailable(408);
  try{const result=input.operation==='list'?await owners.list(session):input.operation==='prepare'?await owners.prepare(session,input.input):input.operation==='reopen'?await owners.reopen(session,input.actionId):input.operation==='confirm'?await owners.confirm(session,input.confirmation):await owners.discard(session,input.confirmation);
   return Response.json(parseModuleActionBrowserResult(input.operation,result),{status:200,headers:responseHeaders});
  }catch{return unavailable(503);}
 };
}
