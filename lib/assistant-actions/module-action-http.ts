/** Strict human browser transport. No model tools, posted actor, source receipt or executor. */
import {z} from 'zod';
import {ModuleActionPrepare,ModuleActionConfirmation,ModuleActionPreparedReview,ModuleActionCompletedReceipt,ModuleActionRetiredReceipt,ModuleActionReviewIndexResult,ProfileModuleActionPrepare,ProfileModuleActionConfirmation,ProfileModuleActionPreparedReview,ProfileModuleActionCompletedReceipt,ProfileModuleActionRetiredReceipt,ProfileModuleActionReviewIndexResult,MODULE_REVIEW_ACK_ACTION,MODULE_ONEHR_ACK_ACTION,ReviewModuleActionPrepare,ReviewModuleActionConfirmation,ReviewModuleActionPreparedReview,ReviewModuleActionCompletedReceipt,ReviewModuleActionRetiredReceipt,ReviewModuleActionReviewIndexResult,OnehrModuleActionPrepare,OnehrModuleActionConfirmation,OnehrModuleActionPreparedReview,OnehrModuleActionCompletedReceipt,OnehrModuleActionRetiredReceipt,OnehrModuleActionReviewIndexResult} from './module-action-review-contract';
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
/** Explicit top-level action discriminator keeps the original notification protocol byte-shaped
 * and refuses implicit action/actor/service inference. ESS packets never resolve provider identity. */
export const ProfileModuleActionBrowserPacket=z.discriminatedUnion('operation',[
 z.object({action:z.literal('ess.profile.request'),operation:z.literal('list')}).strict(),
 z.object({action:z.literal('ess.profile.request'),operation:z.literal('prepare'),input:ProfileModuleActionPrepare}).strict(),
 z.object({action:z.literal('ess.profile.request'),operation:z.literal('reopen'),actionId:z.uuid()}).strict(),
 z.object({action:z.literal('ess.profile.request'),operation:z.literal('confirm'),confirmation:ProfileModuleActionConfirmation}).strict(),
 z.object({action:z.literal('ess.profile.request'),operation:z.literal('discard'),confirmation:ProfileModuleActionConfirmation}).strict(),
]);
export type ProfileModuleActionBrowserPacket=z.infer<typeof ProfileModuleActionBrowserPacket>;
export const ProfileModuleActionBrowserResult=z.discriminatedUnion('kind',[
 ProfileModuleActionReviewIndexResult,z.object({kind:z.literal('prepared'),review:ProfileModuleActionPreparedReview}).strict(),
 z.object({kind:z.literal('completed'),receipt:ProfileModuleActionCompletedReceipt}).strict(),z.object({kind:z.literal('retired'),receipt:ProfileModuleActionRetiredReceipt}).strict(),
]);
export type ProfileModuleActionBrowserResult=z.infer<typeof ProfileModuleActionBrowserResult>;
export function parseProfileModuleActionBrowserResult(packet:ProfileModuleActionBrowserPacket,value:unknown):ProfileModuleActionBrowserResult{
 const result=ProfileModuleActionBrowserResult.parse(value),operation=packet.operation;
 const allowed=operation==='list'?result.kind==='profile_module_review_index':operation==='prepare'?result.kind==='prepared':operation==='confirm'?result.kind==='completed'||result.kind==='retired':operation==='discard'?result.kind==='retired':result.kind!=='profile_module_review_index';
 if(!allowed)throw Error('Module action response unavailable.');
 const id=result.kind==='prepared'?result.review.actionId:result.kind==='completed'||result.kind==='retired'?result.receipt.actionId:null;
 const expected=operation==='reopen'?packet.actionId:operation==='confirm'||operation==='discard'?packet.confirmation.actionId:null;
 if(expected&&id!==expected)throw Error('Module action response unavailable.');
 if(operation==='prepare'&&(result.kind!=='prepared'||JSON.stringify(result.review.content)!==JSON.stringify(packet.input)))throw Error('Module action response unavailable.');
 return result;
}
/** Metadata-only first text-control slice. Availability is still freshly checked by native owners. */
export const ProfileActionChoices=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('choices'),employments:z.array(z.object({employmentId:z.uuid(),employeeCode:z.string().max(100).nullable(),companyName:z.string().min(1).max(240),manualPending:z.boolean(),fields:z.array(z.object({fieldId:z.string().min(1).max(200),baseline:z.string().regex(/^sha256:[a-f0-9]{64}$/),type:z.literal('text')}).strict()).max(32).refine(rows=>new Set(rows.map(row=>row.fieldId)).size===rows.length)}).strict()).max(16).refine(rows=>new Set(rows.map(row=>row.employmentId)).size===rows.length)}).strict(),
 z.object({kind:z.literal('unavailable')}).strict(),
]);
export type ProfileActionChoices=z.infer<typeof ProfileActionChoices>;
type ProfileOwners<Session>=Readonly<{list(session:Session):Promise<unknown>;prepare(session:Session,input:z.infer<typeof ProfileModuleActionPrepare>):Promise<unknown>;reopen(session:Session,id:string):Promise<unknown>;confirm(session:Session,input:z.infer<typeof ProfileModuleActionConfirmation>):Promise<unknown>;discard(session:Session,input:z.infer<typeof ProfileModuleActionConfirmation>):Promise<unknown>}>;
export const ReviewModuleActionBrowserPacket=z.discriminatedUnion('operation',[
 z.object({action:z.literal(MODULE_REVIEW_ACK_ACTION),operation:z.literal('list')}).strict(),
 z.object({action:z.literal(MODULE_REVIEW_ACK_ACTION),operation:z.literal('prepare'),input:ReviewModuleActionPrepare}).strict(),
 z.object({action:z.literal(MODULE_REVIEW_ACK_ACTION),operation:z.literal('reopen'),actionId:z.uuid()}).strict(),
 z.object({action:z.literal(MODULE_REVIEW_ACK_ACTION),operation:z.literal('confirm'),confirmation:ReviewModuleActionConfirmation}).strict(),
 z.object({action:z.literal(MODULE_REVIEW_ACK_ACTION),operation:z.literal('discard'),confirmation:ReviewModuleActionConfirmation}).strict(),
]);
export const OnehrModuleActionBrowserPacket=z.discriminatedUnion('operation',[
 z.object({action:z.literal(MODULE_ONEHR_ACK_ACTION),operation:z.literal('list')}).strict(),
 z.object({action:z.literal(MODULE_ONEHR_ACK_ACTION),operation:z.literal('prepare'),input:OnehrModuleActionPrepare}).strict(),
 z.object({action:z.literal(MODULE_ONEHR_ACK_ACTION),operation:z.literal('reopen'),actionId:z.uuid()}).strict(),
 z.object({action:z.literal(MODULE_ONEHR_ACK_ACTION),operation:z.literal('confirm'),confirmation:OnehrModuleActionConfirmation}).strict(),
 z.object({action:z.literal(MODULE_ONEHR_ACK_ACTION),operation:z.literal('discard'),confirmation:OnehrModuleActionConfirmation}).strict(),
]);
export const PerformanceModuleActionBrowserPacket=z.union([ReviewModuleActionBrowserPacket,OnehrModuleActionBrowserPacket]);
export type PerformanceModuleActionBrowserPacket=z.infer<typeof PerformanceModuleActionBrowserPacket>;
export const ReviewModuleActionBrowserResult=z.discriminatedUnion('kind',[ReviewModuleActionReviewIndexResult,z.object({kind:z.literal('prepared'),review:ReviewModuleActionPreparedReview}).strict(),z.object({kind:z.literal('completed'),receipt:ReviewModuleActionCompletedReceipt}).strict(),z.object({kind:z.literal('retired'),receipt:ReviewModuleActionRetiredReceipt}).strict()]);
export const OnehrModuleActionBrowserResult=z.discriminatedUnion('kind',[OnehrModuleActionReviewIndexResult,z.object({kind:z.literal('prepared'),review:OnehrModuleActionPreparedReview}).strict(),z.object({kind:z.literal('completed'),receipt:OnehrModuleActionCompletedReceipt}).strict(),z.object({kind:z.literal('retired'),receipt:OnehrModuleActionRetiredReceipt}).strict()]);
export type PerformanceModuleActionBrowserResult=z.infer<typeof ReviewModuleActionBrowserResult>|z.infer<typeof OnehrModuleActionBrowserResult>;
export function parsePerformanceModuleActionBrowserResult(packet:PerformanceModuleActionBrowserPacket,value:unknown):PerformanceModuleActionBrowserResult{
 const result=packet.action===MODULE_REVIEW_ACK_ACTION?ReviewModuleActionBrowserResult.parse(value):OnehrModuleActionBrowserResult.parse(value),operation=packet.operation;
 const index=result.kind==='review_module_review_index'||result.kind==='onehr_module_review_index';
 if(!(operation==='list'?index:operation==='prepare'?result.kind==='prepared':operation==='confirm'?result.kind==='completed'||result.kind==='retired':operation==='discard'?result.kind==='retired':!index))throw Error('Module action response unavailable.');
 const id=result.kind==='prepared'?result.review.actionId:result.kind==='completed'||result.kind==='retired'?result.receipt.actionId:null;
 const expected=operation==='reopen'?packet.actionId:operation==='confirm'||operation==='discard'?packet.confirmation.actionId:null;if(expected&&expected!==id)throw Error('Module action response unavailable.');
 if(operation==='prepare'){if(result.kind!=='prepared')throw Error('Module action response unavailable.');const reviewed=result.review.review,source=reviewed.engine==='standard_cycle_only'?reviewed.reviewId:reviewed.planId;const selected=packet.action===MODULE_REVIEW_ACK_ACTION?packet.input.intent.reviewId:packet.input.intent.planId;if(source!==selected)throw Error('Module action response unavailable.');}
 return result;
}
export const PerformanceActionChoices=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('choices'),truncated:z.boolean(),items:z.array(z.discriminatedUnion('action',[
  z.object({action:z.literal(MODULE_REVIEW_ACK_ACTION),sourceId:z.uuid(),employmentId:z.uuid(),cycleName:z.string().min(1).max(240),periodStart:z.iso.date(),periodEnd:z.iso.date()}).strict(),
  z.object({action:z.literal(MODULE_ONEHR_ACK_ACTION),sourceId:z.uuid(),employmentId:z.uuid(),reviewId:z.uuid(),planYear:z.number().int(),conversationHeldOn:z.iso.date().nullable()}).strict(),
 ])).max(25).refine(rows=>new Set(rows.map(row=>row.action+':'+row.sourceId)).size===rows.length)}).strict(),z.object({kind:z.literal('unavailable')}).strict(),
]);
export type PerformanceActionChoices=z.infer<typeof PerformanceActionChoices>;
type PerformanceOwners<Session>=Readonly<{
 list(session:Session,action:typeof MODULE_REVIEW_ACK_ACTION|typeof MODULE_ONEHR_ACK_ACTION):Promise<unknown>;
 prepare(session:Session,input:z.infer<typeof ReviewModuleActionPrepare>|z.infer<typeof OnehrModuleActionPrepare>):Promise<unknown>;
 reopen(session:Session,action:typeof MODULE_REVIEW_ACK_ACTION|typeof MODULE_ONEHR_ACK_ACTION,id:string):Promise<unknown>;
 confirm(session:Session,input:z.infer<typeof ReviewModuleActionConfirmation>|z.infer<typeof OnehrModuleActionConfirmation>):Promise<unknown>;
 discard(session:Session,input:z.infer<typeof ReviewModuleActionConfirmation>|z.infer<typeof OnehrModuleActionConfirmation>):Promise<unknown>;
}>;
const SharedBrowserPacket=z.union([ModuleActionBrowserPacket,ProfileModuleActionBrowserPacket,PerformanceModuleActionBrowserPacket]);
type SharedBrowserPacket=z.infer<typeof SharedBrowserPacket>;
export type ModuleActionBrowserOwners<Session>=Readonly<{
 authenticate():Promise<Session>;
 profile?:ProfileOwners<Session>;
 performance?:PerformanceOwners<Session>;
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
async function packet(request:Request):Promise<SharedBrowserPacket>{
 const length=request.headers.get('content-length');if(length!==null&&(!/^\d+$/.test(length)||!Number.isSafeInteger(Number(length))||Number(length)>20480))throw Error();
 if(!request.body||request.signal.aborted)throw Error();
 const reader=request.body.getReader(),chunks:Uint8Array[]=[];let bytes=0,fragments=0,rejectAbort!:()=>void;
 const stopped=new Promise<never>((_,reject)=>{rejectAbort=()=>reject(Error());});void stopped.catch(()=>{});
 const abort=()=>{rejectAbort();void reader.cancel().catch(()=>{});};request.signal.addEventListener('abort',abort,{once:true});if(request.signal.aborted)abort();const timer=setTimeout(abort,5000);
 try{for(;;){if(++fragments>512)throw Error();const part=await Promise.race([reader.read(),stopped]);if(part.done)break;bytes+=part.value.byteLength;if(bytes>20480)throw Error();chunks.push(part.value);}
  if(request.signal.aborted)throw Error();const body=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
  return SharedBrowserPacket.parse(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body)));
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
  let input:SharedBrowserPacket;try{input=await packet(request);}catch{return unavailable(400);}
  let session:Session;try{session=await owners.authenticate();}catch{return unavailable(401);}
  if(request.signal.aborted)return unavailable(408);
  try{if('action' in input&&(input.action===MODULE_REVIEW_ACK_ACTION||input.action===MODULE_ONEHR_ACK_ACTION)){const performance=owners.performance;if(!performance)return unavailable(503);const result=input.operation==='list'?await performance.list(session,input.action):input.operation==='prepare'?await performance.prepare(session,input.input):input.operation==='reopen'?await performance.reopen(session,input.action,input.actionId):input.operation==='confirm'?await performance.confirm(session,input.confirmation):await performance.discard(session,input.confirmation);return Response.json(parsePerformanceModuleActionBrowserResult(input,result),{status:200,headers:responseHeaders});}
   if('action' in input&&input.action==='ess.profile.request'){const profile=owners.profile;if(!profile)return unavailable(503);const result=input.operation==='list'?await profile.list(session):input.operation==='prepare'?await profile.prepare(session,input.input):input.operation==='reopen'?await profile.reopen(session,input.actionId):input.operation==='confirm'?await profile.confirm(session,input.confirmation):await profile.discard(session,input.confirmation);return Response.json(parseProfileModuleActionBrowserResult(input,result),{status:200,headers:responseHeaders});}
   if('action' in input)return unavailable(400);
   const result=input.operation==='list'?await owners.list(session):input.operation==='prepare'?await owners.prepare(session,input.input):input.operation==='reopen'?await owners.reopen(session,input.actionId):input.operation==='confirm'?await owners.confirm(session,input.confirmation):await owners.discard(session,input.confirmation);
   return Response.json(parseModuleActionBrowserResult(input.operation,result),{status:200,headers:responseHeaders});
  }catch{return unavailable(503);}
 };
}
