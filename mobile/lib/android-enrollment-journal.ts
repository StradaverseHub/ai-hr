/** Durable Android enrollment intent/proof/receipt model. Cached receipts never authorize attendance. */
import {z} from 'zod';
import {AndroidEnrollmentKeyArtifact,AndroidEnrollmentPreparation,androidEnrollmentClientData,androidEnrollmentAliasData,androidNativeKeyReferenceData} from '../../lib/mobile-android-enrollment';
import {nativeKeyBindingData} from '../../lib/mobile-key-enrollment';
import * as C from '../../lib/mobile-integrity-contract';
import {EnrollmentScope,EnrollmentConflict,EnrollmentJournalUnavailable} from './enrollment-journal';
import type {NativeIntegrityResult} from './integrity-bridge';
const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const intent=z.object({employmentId:uuid,requestId:uuid}).strict();
const prepared=C.IntegrityAndroidEnrollmentPrepared.options[0];
const bound=intent.extend({prepared}).strict();
const pending=z.discriminatedUnion('phase',[
 intent.extend({phase:z.literal('requested')}).strict(),
 bound.extend({phase:z.literal('prepared')}).strict(),
 bound.extend({phase:z.literal('key_requested')}).strict(),
 bound.extend({phase:z.literal('proof_ready'),proof:AndroidEnrollmentKeyArtifact}).strict(),
]);
const registered=bound.extend({publicKeySpki:AndroidEnrollmentKeyArtifact.shape.publicKeySpki,key:C.IntegrityAndroidKeyReceipt}).strict();
const fields={revision:z.number().int().positive().max(999999999999999),scope:EnrollmentScope,pending:pending.nullable(),key:registered.nullable(),retired:z.array(registered).max(16)};
const snapshot=z.discriminatedUnion('version',[
 z.object({version:z.literal(1),...fields}).strict(),
 z.object({version:z.literal(2),...fields,revocation:z.literal('requested')}).strict(),
]);
export type AndroidEnrollmentSnapshot=z.infer<typeof snapshot>;
type Pending=z.infer<typeof pending>;
type Prepared=z.infer<typeof prepared>;
type Registered=z.infer<typeof registered>;
type Key=z.infer<typeof C.IntegrityAndroidKeyReceipt>;
type Artifact=z.infer<typeof AndroidEnrollmentKeyArtifact>;
type NativePrepared=z.infer<typeof AndroidEnrollmentPreparation>;
type Evidence=Artifact&{reportedSecurityLevel:string};
export type AndroidEnrollmentPorts={
 assertCurrent():void;
 read():Promise<AndroidEnrollmentSnapshot|null>;
 commit(value:AndroidEnrollmentSnapshot):Promise<void>;
 digest(value:string,encoding:'hex'|'base64'):Promise<string>;
 native:{read(input:unknown):Promise<NativeIntegrityResult<Evidence>>;create(input:unknown,persist:(value:NativePrepared)=>Promise<void>):Promise<NativeIntegrityResult<Evidence>>};
 prepare(employmentId:string,input:{requestId:string;appInstallationId:string}):Promise<unknown>;
 complete(employmentId:string,input:z.infer<typeof C.IntegrityAndroidEnrollmentProof>):Promise<unknown>;
 receipt(employmentId:string,input:z.infer<typeof C.IntegrityKeyLookupIntent>):Promise<unknown>;
 revoke(employmentId:string,input:z.infer<typeof C.IntegrityRevokeIntent>):Promise<unknown>;
};
type Reason='server_unavailable'|'server_refused'|'native_unavailable'|'unsupported'|'recovery_required'|'challenge_unavailable'|'history_full';
export type AndroidEnrollmentStatus={status:'empty'}|{status:'pending';requestId:string;employmentId:string;phase:Pending['phase'];reason?:Reason}|
 {status:'stored_key';keyId:string;revoked:boolean;reason?:Reason}|{status:'revocation_pending';keyId:string;reason?:Reason};
function checked<S extends z.ZodType>(schema:S,input:unknown):z.output<S>{try{return schema.parse(input);}catch{throw new EnrollmentJournalUnavailable();}}
function contextMatches(scope:EnrollmentScope,value:z.infer<typeof bound>){
 const c=value.prepared.context;return c.apiOrigin===scope.apiOrigin&&c.actorId===scope.actorId&&c.appInstallationId===scope.appInstallationId&&c.employmentId===value.employmentId&&c.requestId===value.requestId;
}
function receiptMatches(key:Key,p:Prepared){return key.originChallengeId===p.context.challengeId&&key.appId===p.context.target.packageName&&key.platform==='android'&&key.environment===null&&key.proofKind==='google_key_generation_proof';}
const sameReceipt=(a:Key,b:Key)=>JSON.stringify({...a,revokedAt:null})===JSON.stringify({...b,revokedAt:null});
export function parseAndroidEnrollmentSnapshot(input:unknown,rawScope:EnrollmentScope):AndroidEnrollmentSnapshot{
 try{
  const scope=EnrollmentScope.parse(rawScope),s=snapshot.parse(input);
  if(JSON.stringify(scope)!==JSON.stringify(s.scope)||s.pending&&s.key||s.version===2&&(!s.key||s.key.key.revokedAt!==null||s.pending))throw new Error();
  if(s.pending&&s.pending.phase!=='requested'&&!contextMatches(scope,s.pending))throw new Error();
  const records=[...s.retired,...(s.key?[s.key]:[])];
  for(const record of records)if(!contextMatches(scope,record)||!receiptMatches(record.key,record.prepared))throw new Error();
  if(s.retired.some(record=>record.key.revokedAt===null))throw new Error();
  const requests=[...records.map(value=>value.requestId),...(s.pending?[s.pending.requestId]:[])];
  const challenges=[...records.map(value=>value.prepared.context.challengeId),...(s.pending&&s.pending.phase!=='requested'?[s.pending.prepared.context.challengeId]:[])];
  if(new Set(requests).size!==requests.length||new Set(records.map(value=>value.key.keyId)).size!==records.length||new Set(challenges).size!==challenges.length)throw new Error();
  return s;
 }catch{throw new EnrollmentJournalUnavailable();}
}
const queues=new Map<string,Promise<void>>();
function exclusive<T>(key:string,run:()=>Promise<T>){const next=(queues.get(key)??Promise.resolve()).then(run),tail=next.then(()=>{},()=>{});queues.set(key,tail);return next.finally(()=>{if(queues.get(key)===tail)queues.delete(key);});}
export function createAndroidEnrollmentJournal(rawScope:EnrollmentScope,ports:AndroidEnrollmentPorts){
 const scope=EnrollmentScope.parse(rawScope),queue=JSON.stringify(scope);
 async function owned<T>(work:()=>Promise<T>){ports.assertCurrent();try{const value=await work();ports.assertCurrent();return value;}catch(error){ports.assertCurrent();throw error;}}
 async function checkPrepared(value:Prepared,i:z.infer<typeof intent>){
  if(!contextMatches(scope,{...i,prepared:value}))throw new EnrollmentConflict();
  const digest=await owned(()=>ports.digest(androidEnrollmentClientData(value.context),'base64'));
  const alias='aihr_'+await owned(()=>ports.digest(androidEnrollmentAliasData(value.context),'hex'));
  if(value.clientDataHash!==digest||value.alias!==alias)throw new EnrollmentConflict();
 }
 async function checkKey(key:Key,p:Prepared,publicKeySpki:string){
  if(!receiptMatches(key,p))throw new EnrollmentConflict();
  const reference=await owned(()=>ports.digest(androidNativeKeyReferenceData(publicKeySpki),'base64'));
  const binding=await owned(()=>ports.digest(nativeKeyBindingData(p.context.challengeId,reference),'hex'));
  if(binding!==key.nativeKeyBinding)throw new EnrollmentConflict();
 }
 async function read(){
  const raw=await owned(()=>ports.read());if(!raw)return {version:1 as const,revision:0,scope,pending:null,key:null,retired:[] as Registered[]};
  const s=parseAndroidEnrollmentSnapshot(raw,scope);
  if(s.pending&&s.pending.phase!=='requested')await checkPrepared(s.pending.prepared,s.pending);
  for(const key of [...s.retired,...(s.key?[s.key]:[])]){await checkPrepared(key.prepared,key);await checkKey(key.key,key.prepared,key.publicKeySpki);}return s;
 }
 type State=Awaited<ReturnType<typeof read>>;
 async function save(s:State,p:Pending|null,key:Registered|null=null,revoking=false,retired=s.retired){
  const next=parseAndroidEnrollmentSnapshot({version:revoking?2:1,revision:s.revision+1,scope,pending:p,key,retired,...(revoking?{revocation:'requested'}:{})},scope);
  try{await owned(()=>ports.commit(structuredClone(next)));}catch{ports.assertCurrent();throw new EnrollmentJournalUnavailable();}return next;
 }
 function status(s:State,reason?:Reason):AndroidEnrollmentStatus{
  if(s.key){if(s.version===2)return {status:'revocation_pending',keyId:s.key.key.keyId,...(reason?{reason}:{})};return {status:'stored_key',keyId:s.key.key.keyId,revoked:s.key.key.revokedAt!==null,...(reason?{reason}:{})};}
  return s.pending?{status:'pending',requestId:s.pending.requestId,employmentId:s.pending.employmentId,phase:s.pending.phase,...(reason?{reason}:{})}:{status:'empty'};
 }
 function nativeReason(value:{status:string;reason?:string}):Reason{return value.status==='unsupported'?'unsupported':['invalid_key','key_exists','recovery_required','binding_conflict'].includes(value.reason??'')?'recovery_required':'native_unavailable';}
 async function lookup(employmentId:string,challengeId:string){return checked(C.IntegrityKeyLookupResultV2,await owned(()=>ports.receipt(employmentId,{originChallengeId:challengeId})));}
 async function register(s:State,p:z.infer<typeof bound>,publicKeySpki:string,key:Key){await checkKey(key,p.prepared,publicKeySpki);return status(await save(s,null,{...p,publicKeySpki,key}));}
 async function reconcileKey(s:State,selected:string){
  const original=s.key!;const value=await lookup(selected,original.prepared.context.challengeId);
  if(value.outcome!=='key_receipt')return {state:s,reason:value.outcome==='refused'?'server_refused' as const:'server_unavailable' as const};
  if(!value.key)return {state:s,reason:'recovery_required' as const};
  const key=checked(C.IntegrityAndroidKeyReceipt,value.key);await checkKey(key,original.prepared,original.publicKeySpki);
  if(!sameReceipt(original.key,key)||original.key.revokedAt!==null&&key.revokedAt!==original.key.revokedAt)throw new EnrollmentConflict();
  if(key.revokedAt!==null)return {state:await save(s,null,{...original,key})};
  return {state:s};
 }
 return {
  status:()=>exclusive(queue,async()=>status(await read())),
  begin:(employmentId:string,requestId:string)=>exclusive(queue,async()=>{
   const i=intent.parse({employmentId,requestId}),s=await read();
   if(s.key)return status(s);if(s.pending){if(s.pending.employmentId!==i.employmentId)throw new EnrollmentConflict();return status(s);}
   if(s.retired.some(value=>value.requestId===i.requestId))throw new EnrollmentConflict();return status(await save(s,{...i,phase:'requested'}));
  }),
  replace:(employmentId:string,requestId:string)=>exclusive(queue,async()=>{
   const i=intent.parse({employmentId,requestId});let s:State=await read();if(!s.key||s.pending)throw new EnrollmentConflict();
   const reconciled=await reconcileKey(s,i.employmentId);s=reconciled.state;if(reconciled.reason)return status(s,reconciled.reason);
   if(!s.key||s.key.key.revokedAt===null)return status(s,'recovery_required');
   if(s.retired.length===16)return status(s,'history_full');
   if(s.key.requestId===i.requestId||s.retired.some(value=>value.requestId===i.requestId))throw new EnrollmentConflict();
   return status(await save(s,{...i,phase:'requested'},null,false,[...s.retired,s.key]));
  }),
  revoke:(employmentId:string)=>exclusive(queue,async()=>{
   const selected=uuid.parse(employmentId);let s:State=await read();if(!s.key)throw new EnrollmentConflict();
   if(s.key.key.revokedAt!==null)return status(s);
   if(s.version!==2)s=await save(s,null,s.key,true);
   const reconciled=await reconcileKey(s,selected);s=reconciled.state;if(reconciled.reason)return status(s,reconciled.reason);if(s.version!==2)return status(s);
   const original=s.key!,value=checked(C.IntegrityRevocationResultV2,await owned(()=>ports.revoke(selected,{keyId:original.key.keyId})));
   if(value.outcome!=='revoked')return status(s,value.outcome==='refused'?'server_refused':'server_unavailable');
   const key=checked(C.IntegrityAndroidKeyReceipt,value.key);
   if(key.revokedAt===null||!sameReceipt(original.key,key))throw new EnrollmentConflict();
   await checkKey(key,original.prepared,original.publicKeySpki);return status(await save(s,null,{...original,key}));
  }),
  advance:(employmentId:string)=>exclusive(queue,async()=>{
   const selected=uuid.parse(employmentId);let s:State=await read();const retained=s.pending;
   if(!retained){if(!s.key)return status(s);const found=await reconcileKey(s,selected);return status(found.state,found.reason);}
   let p:Pending=retained;
   const recoveryOnly=p.employmentId!==selected;
   if(recoveryOnly&&p.phase==='requested')return status(s,'recovery_required');
   const intentRef={employmentId:p.employmentId,requestId:p.requestId};let refreshed=false,reconciled=false;
   for(let steps=0;steps<6;steps++){
    ports.assertCurrent();
    if(p.phase==='requested'){
     const value=checked(C.IntegrityAndroidEnrollmentPrepared,await owned(()=>ports.prepare(selected,{requestId:intentRef.requestId,appInstallationId:scope.appInstallationId})));
     if(value.outcome!=='prepared')return status(s,value.outcome==='refused'?'server_refused':'server_unavailable');
     await checkPrepared(value,intentRef);p={...intentRef,phase:'prepared',prepared:value};s=await save(s,p);refreshed=true;
    }
    const current:Exclude<Pending,{phase:'requested'}>=p,preparedRef:Prepared=current.prepared;await checkPrepared(preparedRef,intentRef);
    if(!reconciled){
     const value=await lookup(selected,preparedRef.context.challengeId);if(value.outcome!=='key_receipt')return status(s,value.outcome==='refused'?'server_refused':'server_unavailable');
     if(value.key){
      const key=checked(C.IntegrityAndroidKeyReceipt,value.key);let publicKeySpki:string;
      if(current.phase==='proof_ready')publicKeySpki=current.proof.publicKeySpki;
      else{const result=await owned(()=>ports.native.read(preparedRef));if(result.status!=='evidence')return status(s,nativeReason(result));publicKeySpki=checked(AndroidEnrollmentKeyArtifact,{publicKeySpki:result.evidence.publicKeySpki,certificateChain:result.evidence.certificateChain}).publicKeySpki;}
      return register(s,{...intentRef,prepared:preparedRef},publicKeySpki,key);
     }
     reconciled=true;
    }
    // The selector may be a newer own employment. Only reconcile an existing receipt through it;
    // the original command subject can never be rewritten for generation or proof submission.
    if(recoveryOnly)return status(s,'recovery_required');
    if(current.phase==='proof_ready'){
     const value=checked(C.IntegrityAndroidEnrollmentResult,await owned(()=>ports.complete(selected,{...current.proof,requestId:current.requestId,appInstallationId:scope.appInstallationId,challengeId:preparedRef.context.challengeId})));
     if(value.outcome!=='enrolled')return status(s,value.outcome==='refused'?'server_refused':'server_unavailable');
     return register(s,{...intentRef,prepared:preparedRef},current.proof.publicKeySpki,value.key);
    }
    if(current.phase==='key_requested'){
     const result=await owned(()=>ports.native.read(preparedRef));if(result.status!=='evidence')return status(s,nativeReason(result));
     const proof=checked(AndroidEnrollmentKeyArtifact,{publicKeySpki:result.evidence.publicKeySpki,certificateChain:result.evidence.certificateChain});
     p={...intentRef,prepared:preparedRef,phase:'proof_ready',proof};s=await save(s,p);continue;
    }
    if(!refreshed){
     const value=checked(C.IntegrityAndroidEnrollmentPrepared,await owned(()=>ports.prepare(selected,{requestId:intentRef.requestId,appInstallationId:scope.appInstallationId})));
     if(value.outcome!=='prepared')return status(s,value.outcome==='refused'?'server_refused':'server_unavailable');await checkPrepared(value,intentRef);
     if(androidEnrollmentClientData(value.context)!==androidEnrollmentClientData(preparedRef.context)||value.alias!==preparedRef.alias||value.clientDataHash!==preparedRef.clientDataHash)throw new EnrollmentConflict();
     p={...current,prepared:value};s=await save(s,p);refreshed=true;continue;
    }
    if(preparedRef.state!=='active')return status(s,'challenge_unavailable');
    const generation={state:s,committed:false};
    const result=await owned(()=>ports.native.create(preparedRef,async value=>{
     if(androidEnrollmentClientData(value.context)!==androidEnrollmentClientData(preparedRef.context)||value.alias!==preparedRef.alias||value.clientDataHash!==preparedRef.clientDataHash||value.state!=='active'||value.protocol!==2)throw new EnrollmentConflict();
     generation.state=await save(s,{...intentRef,phase:'key_requested',prepared:preparedRef});generation.committed=true;
    }));
    s=generation.state;if(result.status!=='evidence')return status(s,nativeReason(result));if(!generation.committed)throw new EnrollmentJournalUnavailable();
    p={...intentRef,prepared:preparedRef,phase:'proof_ready',proof:checked(AndroidEnrollmentKeyArtifact,{publicKeySpki:result.evidence.publicKeySpki,certificateChain:result.evidence.certificateChain})};s=await save(s,p);
   }
   throw new EnrollmentJournalUnavailable();
  }),
 };
}
