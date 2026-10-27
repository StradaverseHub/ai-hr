/** One durable signed attempt per installed account. No offline acceptance, implicit replay or trust tier. */
import {z} from 'zod';
import {ClockCommand,ClockReceipt,SubmissionReceiptResponse,SubmissionAbandonResponse} from '../../lib/mobile-api/contract';
import {ClockSourceSignals,OnlineClockIntegrityData,onlineClockClientData} from '../../lib/mobile-clock-integrity';
import * as C from '../../lib/mobile-integrity-contract';
import {AndroidPlayCloudProject} from '../../lib/mobile-android-clock-policy';
import {EnrollmentScope} from './enrollment-journal';
import {ClockSigningKey} from './clock-signing-key';
import {NativeCapabilities,type NativeIntegrityResult} from './integrity-bridge';
const uuid=z.string().uuid().transform(value=>value.toLowerCase()),sha=z.string().length(64).regex(/^[a-f0-9]{64}$/);
const reference=z.object({employmentId:uuid,requestId:uuid,baseDigest:sha,action:z.enum(['in','out'])}).strict();
const disposition=z.object({receipt:ClockReceipt.nullable(),abandoned:z.boolean()}).strict().refine(value=>!!value.receipt!==value.abandoned);
const active=reference.extend({phase:z.enum(['intent','prepared','proof_ready','sent']),key:ClockSigningKey,
 evidence:OnlineClockIntegrityData.shape.evidence,project:AndroidPlayCloudProject.nullable(),
 context:OnlineClockIntegrityData.nullable(),proof:z.string().min(4).max(10924).nullable()}).strict();
const settled=reference.extend({phase:z.literal('settled'),disposition}).strict();
const pending=z.union([active,settled]);
const snapshot=z.object({version:z.literal(1),revision:z.number().int().positive().max(999999999999999),scope:EnrollmentScope,pending:pending.nullable()}).strict();
export type SignedClockSnapshot=z.infer<typeof snapshot>;
export type SignedClockReference=z.infer<typeof reference>;
export type SignedClockPending=z.infer<typeof active>;
const baseSchema=z.object({digest:sha,command:ClockCommand,photo:OnlineClockIntegrityData.shape.command.shape.photo,source:ClockSourceSignals}).strict();
export type SignedClockBase=z.infer<typeof baseSchema>;
export class SignedClockConflict extends Error{constructor(){super('Review the saved signed clock attempt');this.name='SignedClockConflict';}}
export class SignedClockUnavailable extends Error{constructor(readonly reason='unavailable'){super('Signed clocking unavailable');this.name='SignedClockUnavailable';}}
export type SignedClockStatus={status:'empty'}|{status:'other_pending'}|
 {status:'pending';requestId:string;action:'in'|'out';phase:z.infer<typeof pending>['phase'];reason?:string}|
 {status:'accepted';receipt:z.infer<typeof ClockReceipt>}|{status:'abandoned'};
export type SignedClockPorts={
 assertCurrent():void;read():Promise<SignedClockSnapshot|null>;commit(value:SignedClockSnapshot):Promise<void>;
 base(employmentId:string,requestId:string):Promise<SignedClockBase>;
 key():Promise<{key:ClockSigningKey;capability:z.infer<typeof NativeCapabilities>}>;
 capabilities():Promise<unknown>;
 begin(pending:SignedClockPending,input:unknown):Promise<unknown>;
 sign(key:ClockSigningKey,context:OnlineClockIntegrityData):Promise<NativeIntegrityResult<string>>;
 play(project:string,context:OnlineClockIntegrityData):Promise<NativeIntegrityResult<string>>;
 complete(pending:SignedClockPending,input:unknown,token?:string):Promise<unknown>;
 receipt(employmentId:string,requestId:string):Promise<unknown>;
 abandon(employmentId:string,requestId:string):Promise<unknown>;
 resolveBase(reference:SignedClockReference):Promise<void>;
};
function same(a:unknown,b:unknown){return JSON.stringify(a)===JSON.stringify(b);}
export function parseSignedClockSnapshot(raw:unknown,scope:EnrollmentScope):SignedClockSnapshot{
 try{
  const value=snapshot.parse(raw);if(!same(value.scope,EnrollmentScope.parse(scope)))throw new Error();
  const p=value.pending;if(p&&p.phase!=='settled'){
   if(p.key.apiOrigin!==scope.apiOrigin||p.key.actorId!==scope.actorId||p.key.appInstallationId!==scope.appInstallationId||p.evidence.platform!==p.key.platform)throw new Error();
   if(p.key.platform==='ios'?p.project!==null:p.project===null)throw new Error();
   if(p.phase==='intent'?(p.context!==null||p.proof!==null):!p.context)throw new Error();
   if((p.phase==='proof_ready'||p.phase==='sent')!==!!p.proof)throw new Error();
   if(p.proof&&!(p.key.platform==='ios'?C.IntegrityClockProof.shape.assertion:C.IntegrityAndroidClockProof.shape.signature).safeParse(p.proof).success)throw new Error();
   if(p.context){const c=p.context;if(c.scope.apiOrigin!==scope.apiOrigin||c.scope.actorId!==scope.actorId||c.scope.employmentId!==p.employmentId||c.scope.deviceKeyId!==p.key.keyId||c.scope.tenantId!==p.key.tenantId||c.scope.installationId!==p.key.installationId||c.command.requestId!==p.requestId||c.command.action!==p.action||!same(c.evidence,p.evidence))throw new Error();}
  }
  if(p?.phase==='settled'&&p.disposition.receipt&&p.disposition.receipt.direction!==p.action)throw new Error();return value;
 }catch{throw new SignedClockUnavailable('storage');}
}
const queues=new Map<string,Promise<void>>();
function exclusive<T>(key:string,work:()=>Promise<T>){const next=(queues.get(key)??Promise.resolve()).then(work),tail=next.then(()=>{},()=>{});queues.set(key,tail);return next.finally(()=>{if(queues.get(key)===tail)queues.delete(key);});}
export function createSignedClockJournal(rawScope:EnrollmentScope,ports:SignedClockPorts){
 const scope=EnrollmentScope.parse(rawScope),queue=JSON.stringify(['signed-clock-v1',scope]);
 async function owned<T>(work:()=>Promise<T>){ports.assertCurrent();try{const value=await work();ports.assertCurrent();return value;}catch(error){ports.assertCurrent();throw error;}}
 async function read(){const raw=await owned(()=>ports.read());return raw?parseSignedClockSnapshot(raw,scope):{version:1 as const,revision:0,scope,pending:null};}
 type State=Awaited<ReturnType<typeof read>>;
 async function save(s:State,p:SignedClockSnapshot['pending']){const next=parseSignedClockSnapshot({version:1,revision:s.revision+1,scope,pending:p},scope);await owned(()=>ports.commit(structuredClone(next)));return next;}
 function status(s:State,selected:string,reason?:string):SignedClockStatus{
  const p=s.pending;return !p?{status:'empty'}:p.employmentId!==selected?{status:'other_pending'}:{status:'pending',requestId:p.requestId,action:p.action,phase:p.phase,...(reason?{reason}:{})};
 }
 async function base(p:SignedClockReference){const value=baseSchema.parse(await owned(()=>ports.base(p.employmentId,p.requestId)));if(value.digest!==p.baseDigest||value.command.requestId!==p.requestId||value.command.action!==p.action)throw new SignedClockConflict();return value;}
 function intent(p:SignedClockPending,b:SignedClockBase){const {deviceToken,...command}=b.command;return {appInstallationId:scope.appInstallationId,keyId:p.key.keyId,...(deviceToken?{deviceToken}:{}),command,evidence:p.evidence};}
 function checkedDisposition(value:unknown,p:SignedClockReference,abandon=false){const result=(abandon?SubmissionAbandonResponse:SubmissionReceiptResponse).parse(value);if(result.kind!=='clock'||result.requestId!==p.requestId||result.receipt&&result.receipt.direction!==p.action)throw new SignedClockConflict();return result.receipt?{receipt:result.receipt,abandoned:false}:result.abandoned?{receipt:null,abandoned:true}:null;}
 async function finish(s:State,p:SignedClockReference,d:z.infer<typeof disposition>):Promise<SignedClockStatus>{
  const ref=reference.parse({employmentId:p.employmentId,requestId:p.requestId,baseDigest:p.baseDigest,action:p.action});
  const confirmed=await save(s,{...ref,phase:'settled',disposition:d});
  await owned(()=>ports.resolveBase(ref));await save(confirmed,null);
  return d.receipt?{status:'accepted',receipt:d.receipt}:{status:'abandoned'};
 }
 async function observe(s:State,p:z.infer<typeof pending>){const d=checkedDisposition(await owned(()=>ports.receipt(p.employmentId,p.requestId)),p);return d?finish(s,p,d):null;}
 async function capabilities(platform:'ios'|'android'){
  const value=C.IntegrityClockCapabilities.parse(await owned(()=>ports.capabilities()));
  if(value.outcome!=='capabilities'||value.platform!==platform)throw new SignedClockUnavailable('configuration');return value;
 }
 return {
  status:(employmentId:string)=>exclusive(queue,async()=>status(await read(),uuid.parse(employmentId))),
  start:(employmentId:string,requestId:string)=>exclusive(queue,async()=>{
   const selected=uuid.parse(employmentId),id=uuid.parse(requestId),s=await read();
   if(s.pending){if(s.pending.employmentId!==selected||s.pending.requestId!==id)throw new SignedClockConflict();return status(s,selected);}
   const b=baseSchema.parse(await owned(()=>ports.base(selected,id)));if(b.command.requestId!==id)throw new SignedClockConflict();
   const found=await owned(()=>ports.key()),key=ClockSigningKey.parse(found.key),cap=NativeCapabilities.parse(found.capability),features=await capabilities(key.platform);
   if(key.actorId!==scope.actorId||key.apiOrigin!==scope.apiOrigin||key.appInstallationId!==scope.appInstallationId||cap.platform!==key.platform||
    (key.platform==='ios'?cap.keyMechanism!=='apple_app_attest'||!key.appId.endsWith('.'+cap.appId):cap.keyMechanism!=='android_keystore'||key.appId!==cap.appId))throw new SignedClockConflict();
   const p:SignedClockPending={phase:'intent',employmentId:selected,requestId:id,baseDigest:b.digest,action:b.command.action,key,
    evidence:OnlineClockIntegrityData.shape.evidence.parse({platform:cap.platform,appId:cap.appId,appVersion:cap.appVersion,buildVersion:cap.buildVersion,...b.source}),
    project:features.cloudProjectNumber,context:null,proof:null};
   return status(await save(s,p),selected);
  }),
  recover:(employmentId:string,abandon=false,expectedRequestId?:string)=>exclusive(queue,async()=>{
   const selected=uuid.parse(employmentId),expected=expectedRequestId===undefined?undefined:uuid.parse(expectedRequestId),s=await read(),p=s.pending;if(!p||p.employmentId!==selected)return status(s,selected);
   if(expected!==undefined&&p.requestId!==expected)throw new SignedClockConflict();
   const value=await owned(()=>abandon?ports.abandon(selected,p.requestId):ports.receipt(selected,p.requestId)),d=checkedDisposition(value,p,abandon);
   return d?finish(s,p,d):status(s,selected,'uncertain');
  }),
  advance:(employmentId:string,expectedRequestId?:string)=>exclusive(queue,async()=>{
   const selected=uuid.parse(employmentId),expected=expectedRequestId===undefined?undefined:uuid.parse(expectedRequestId);let s=await read();const p=s.pending;
   if(!p||p.employmentId!==selected)return status(s,selected);
   if(expected!==undefined&&p.requestId!==expected)throw new SignedClockConflict();
   const existing=await observe(s,p);if(existing)return existing;
   if(p.phase==='settled')return status(s,selected,'uncertain');
   let current:SignedClockPending=p;
   const b=await base(current),features=await capabilities(current.key.platform);if(features.cloudProjectNumber!==current.project)throw new SignedClockConflict();
   const request=intent(current,b),prepared=(current.key.platform==='ios'?C.IntegrityClockPrepared:C.IntegrityAndroidClockPrepared).parse(await owned(()=>ports.begin(structuredClone(current),structuredClone(request))));
   if(prepared.outcome!=='prepared')return status(s,selected,prepared.outcome==='refused'?'refused':'unavailable');
   const context=prepared.context,expectedContext=OnlineClockIntegrityData.parse({...context,scope:{apiOrigin:scope.apiOrigin,actorId:scope.actorId,employmentId:selected,deviceKeyId:p.key.keyId,tenantId:p.key.tenantId,installationId:p.key.installationId},command:{...request.command,photo:b.photo},evidence:p.evidence});
   if(onlineClockClientData(context)!==onlineClockClientData(expectedContext)||p.context&&onlineClockClientData(p.context)!==onlineClockClientData(context))throw new SignedClockConflict();
   if(prepared.state!=='active')return status(s,selected,'challenge_unavailable');
   if(current.phase==='intent'){current={...current,phase:'prepared',context};s=await save(s,current);}
   if(!current.proof){
    const signingKey=structuredClone(current.key);
    const found=await owned(()=>ports.key()),freshKey=ClockSigningKey.parse(found.key),cap=NativeCapabilities.parse(found.capability);
    if(!same(freshKey,signingKey)||cap.platform!==current.evidence.platform||cap.appId!==current.evidence.appId||cap.appVersion!==current.evidence.appVersion||cap.buildVersion!==current.evidence.buildVersion)throw new SignedClockConflict();
    const signed=await owned(()=>ports.sign(signingKey,structuredClone(context)));
    if(signed.status!=='evidence')return status(s,selected,signed.status==='unsupported'?'unsupported':'native_unavailable');
    const proof=(current.key.platform==='ios'?C.IntegrityClockProof.shape.assertion:C.IntegrityAndroidClockProof.shape.signature).parse(signed.evidence);
    current={...current,phase:'proof_ready',context,proof};
   }
   let token:string|undefined;
   if(current.key.platform==='android'){
    const project=AndroidPlayCloudProject.parse(current.project);
    const result=await owned(()=>ports.play(project,structuredClone(context)));
    if(result.status!=='evidence')return status(s,selected,result.status==='unsupported'?'unsupported':'native_unavailable');token=C.IntegrityAndroidClockToken.parse(result.evidence);
   }
   if(current.phase!=='sent'){current={...current,phase:'sent'};s=await save(s,current);}
   const proof=current.key.platform==='ios'?{assertion:current.proof!}:{signature:current.proof!};
   const result=C.IntegrityClockResult.parse(await owned(()=>ports.complete(structuredClone(current),{...request,challengeId:context.challenge.id,...proof},token)));
   if(result.outcome!=='accepted')return status(s,selected,result.outcome==='refused'?'refused':'unavailable');
   if(result.receipt.direction!==current.action)throw new SignedClockConflict();return finish(s,current,{receipt:result.receipt,abandoned:false});
  }),
 };
}
