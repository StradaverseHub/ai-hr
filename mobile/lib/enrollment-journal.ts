/** Local enrollment recovery. Only the server owns key enrollment/authorization; no trust tier here. */
import {z} from 'zod';
import {AppleEnrollmentSettings,keyEnrollmentClientData,nativeKeyBindingData} from '../../lib/mobile-key-enrollment';
import * as C from '../../lib/mobile-integrity-contract';
import type {createIntegrityBridge} from './integrity-bridge';

const uuid=z.string().uuid().transform(value=>value.toLowerCase());
const hash32=z.string().length(44).regex(/^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/);
const artifact=z.string().min(4).max(87384).refine(value=>value.trim()===value).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/)
  .refine(value=>value.length/4*3-(value.endsWith('==')?2:value.endsWith('=')?1:0)<=65536);
export const EnrollmentScope=z.object({namespace:z.string().min(1).max(2048),apiOrigin:AppleEnrollmentSettings.shape.apiOrigin,actorId:uuid,appInstallationId:uuid}).strict();
export type EnrollmentScope=z.infer<typeof EnrollmentScope>;
const intent=z.object({employmentId:uuid,requestId:uuid}).strict();
const prepared=C.IntegrityEnrollmentPrepared.options[0];
const bound=intent.extend({prepared}).strict();
const keyed=bound.extend({vendorKeyId:hash32}).strict();
const pending=z.discriminatedUnion('phase',[
  intent.extend({phase:z.literal('requested')}).strict(),
  bound.extend({phase:z.literal('prepared')}).strict(),bound.extend({phase:z.literal('key_requested')}).strict(),
  keyed.extend({phase:z.literal('key_ready')}).strict(),keyed.extend({phase:z.literal('attestation_requested')}).strict(),
  keyed.extend({phase:z.literal('proof_ready'),attestation:artifact}).strict(),
]);
const registered=keyed.extend({key:C.IntegrityKeyReceipt}).strict();
const snapshotFields={revision:z.number().int().positive().max(999999999999999),scope:EnrollmentScope,
  pending:pending.nullable(),key:registered.nullable()};
const snapshot=z.discriminatedUnion('version',[
  z.object({version:z.literal(1),...snapshotFields}).strict(),
  z.object({version:z.literal(2),...snapshotFields,revocation:z.literal('requested')}).strict(),
]);
export type EnrollmentSnapshot=z.infer<typeof snapshot>;
type Pending=z.infer<typeof pending>;
type Prepared=z.infer<typeof prepared>;
type Key=z.infer<typeof C.IntegrityKeyReceipt>;
function checked<S extends z.ZodType>(schema:S,value:unknown):z.output<S>{try{return schema.parse(value);}catch{throw new EnrollmentJournalUnavailable();}}
export class EnrollmentJournalUnavailable extends Error{constructor(){super('Device enrollment storage unavailable');this.name='EnrollmentJournalUnavailable';}}
export class EnrollmentConflict extends Error{constructor(){super('Reconcile the retained device enrollment');this.name='EnrollmentConflict';}}
function receiptMatches(key:Key,p:Prepared){
  return key.originChallengeId===p.context.challengeId&&key.appId===p.context.target.appId&&key.environment===p.context.target.environment&&
    key.proofKind===(p.context.target.requiredMetadata?'apple_app_metadata':'apple_key_proof');
}
function contextMatches(scope:EnrollmentScope,p:z.infer<typeof bound>){
  const c=p.prepared.context;return c.actorId===scope.actorId&&c.apiOrigin===scope.apiOrigin&&c.appInstallationId===scope.appInstallationId&&
    c.employmentId===p.employmentId&&c.requestId===p.requestId;
}
export function parseEnrollmentSnapshot(value:unknown,rawScope:EnrollmentScope):EnrollmentSnapshot{
  try{
    const scope=EnrollmentScope.parse(rawScope),s=snapshot.parse(value);
    if(JSON.stringify(s.scope)!==JSON.stringify(scope)||s.pending&&s.key)throw new Error();
    if(s.version===2&&(!s.key||s.pending||s.key.key.revokedAt!==null))throw new Error();
    if(s.pending&&s.pending.phase!=='requested'&&!contextMatches(scope,s.pending))throw new Error();
    if(s.key&&(!contextMatches(scope,s.key)||!receiptMatches(s.key.key,s.key.prepared)))throw new Error();
    return s;
  }catch{throw new EnrollmentJournalUnavailable();}
}
export type EnrollmentPorts={
  assertCurrent():void;
  read():Promise<EnrollmentSnapshot|null>;
  commit(value:EnrollmentSnapshot):Promise<void>;
  digest(value:string,encoding:'hex'|'base64'):Promise<string>;
  native:ReturnType<typeof createIntegrityBridge>;
  prepare(employmentId:string,intent:{requestId:string;appInstallationId:string}):Promise<unknown>;
  complete(employmentId:string,input:z.infer<typeof C.IntegrityEnrollmentProof>):Promise<unknown>;
  receipt(employmentId:string,input:z.infer<typeof C.IntegrityKeyLookupIntent>):Promise<unknown>;
  revoke(employmentId:string,input:z.infer<typeof C.IntegrityRevokeIntent>):Promise<unknown>;
};
type PendingReason='server_unavailable'|'server_refused'|'vendor_outage'|'native_unavailable'|'unsupported'|'recovery_required'|'challenge_unavailable';
export type EnrollmentStatus={status:'empty'}|{status:'pending';requestId:string;employmentId:string;phase:Pending['phase'];reason?:PendingReason}|
  {status:'stored_key';keyId:string;revoked:boolean}|{status:'revocation_pending';keyId:string;reason?:'server_refused'|'server_unavailable'};
// Shared across all journal instances/generations. A fresh operation always reads the commit pointer;
// it never uses another owner's stale cached snapshot after an ambiguous write or account change.
const queues=new Map<string,Promise<void>>();
function exclusive<T>(key:string,run:()=>Promise<T>):Promise<T>{
  const next=(queues.get(key)??Promise.resolve()).then(run),tail=next.then(()=>{},()=>{});queues.set(key,tail);
  return next.finally(()=>{if(queues.get(key)===tail)queues.delete(key);});
}
export function createEnrollmentJournal(rawScope:EnrollmentScope,ports:EnrollmentPorts){
  const scope=EnrollmentScope.parse(rawScope),queue=JSON.stringify(scope);
  async function owned<T>(work:()=>Promise<T>){ports.assertCurrent();try{const value=await work();ports.assertCurrent();return value;}catch(error){ports.assertCurrent();throw error;}}
  async function read(){
    const raw=await owned(()=>ports.read());if(!raw)return {version:1 as const,revision:0,scope,pending:null,key:null};
    const s=parseEnrollmentSnapshot(raw,scope);
    if(s.pending&&s.pending.phase!=='requested')await checkPrepared(s.pending.prepared,s.pending);
    if(s.key){await checkPrepared(s.key.prepared,s.key);await checkKeyBinding(s.key);}return s;
  }
  async function save(s:Awaited<ReturnType<typeof read>>,p:Pending|null,key:EnrollmentSnapshot['key']=null,revoking=false){
    const next=parseEnrollmentSnapshot({version:revoking?2:1,revision:s.revision+1,scope,pending:p,key,...(revoking?{revocation:'requested'}:{})},scope);
    try{await owned(()=>ports.commit(structuredClone(next)));}catch(error){ports.assertCurrent();throw new EnrollmentJournalUnavailable();}return next;
  }
  async function release(key:NonNullable<EnrollmentSnapshot['key']>){
    // Cleanup is retried on later owned reads. Its unavailability must not turn a committed receipt
    // back into a pending enrollment, but an obsolete owner must still stop before publishing state.
    await owned(()=>ports.native.releaseAppleAttestation(key.vendorKeyId,key.prepared.clientDataHash));
  }
  async function registered(s:Awaited<ReturnType<typeof read>>,key:NonNullable<EnrollmentSnapshot['key']>){
    await checkKeyBinding(key);
    const next=await save(s,null,key);await release(key);return status(next);
  }
  async function checkKeyBinding(key:NonNullable<EnrollmentSnapshot['key']>){
    const expected=await owned(()=>ports.digest(nativeKeyBindingData(key.prepared.context.challengeId,key.vendorKeyId),'hex'));
    if(expected!==key.key.nativeKeyBinding)throw new EnrollmentConflict();
  }
  function status(s:Awaited<ReturnType<typeof read>>,reason?:PendingReason):EnrollmentStatus{
    if(s.version===2&&s.key)return {status:'revocation_pending',keyId:s.key.key.keyId};
    if(s.key)return {status:'stored_key',keyId:s.key.key.keyId,revoked:s.key.key.revokedAt!==null};
    return s.pending?{status:'pending',phase:s.pending.phase,requestId:s.pending.requestId,employmentId:s.pending.employmentId,...(reason?{reason}:{})}:{status:'empty'};
  }
  async function checkPrepared(p:Prepared,i:z.infer<typeof intent>){
    if(!contextMatches(scope,{...i,prepared:p}))throw new EnrollmentConflict();
    const hash=await owned(()=>ports.digest(keyEnrollmentClientData(p.context),'base64'));
    const c=p.context,alias='aihr_'+await owned(()=>ports.digest(JSON.stringify(['aihr-key-alias',1,c.installationId,c.tenantId,c.actorId,c.appInstallationId,c.challengeId]),'hex'));
    if(hash!==p.clientDataHash||alias!==p.alias)throw new EnrollmentConflict();
  }
  function nativeReason(result:{status:string;reason?:string}):PendingReason{
    if(result.status==='unsupported')return 'unsupported';if(result.reason==='server_unavailable')return 'vendor_outage';
    if(['recovery_required','binding_conflict','invalid_key'].includes(result.reason??''))return 'recovery_required';return 'native_unavailable';
  }
  async function keyReference(p:Prepared):Promise<{vendorKeyId:string}|{reason:PendingReason}>{
    const value=await owned(()=>ports.native.appleKeyInfo(p.alias));
    if(value.status!=='evidence')return {reason:nativeReason(value)};
    return value.evidence===null?{reason:'recovery_required'}:{vendorKeyId:checked(hash32,value.evidence)};
  }
  return {
    status:()=>exclusive(queue,async()=>{const s=await read();if(s.key)await release(s.key);return status(s);}),
    revoke:(employmentId:string)=>exclusive(queue,async()=>{
      const selected=uuid.parse(employmentId);let s=await read();
      if(!s.key)throw new EnrollmentConflict();
      if(s.key.key.revokedAt!==null){await release(s.key);return status(s);}
      // Durable intent precedes transport. Neither a lost reply nor a restart restores local key use.
      if(s.version!==2)s=await save(s,null,s.key,true);
      const key=s.key!;
      const value=checked(C.IntegrityRevocationResult,await owned(()=>ports.revoke(selected,{keyId:key.key.keyId})));
      if(value.outcome!=='revoked')return {status:'revocation_pending' as const,keyId:key.key.keyId,reason:value.outcome==='refused'?'server_refused' as const:'server_unavailable' as const};
      // Only the same immutable enrollment with an actual server revocation timestamp resolves intent.
      const original={...key.key,revokedAt:null},returned={...value.key,revokedAt:null};
      if(value.key.revokedAt===null||JSON.stringify(original)!==JSON.stringify(returned))throw new EnrollmentConflict();
      const next=await save(s,null,{...key,key:value.key});await release(key);return status(next);
    }),
    begin:(employmentId:string,requestId:string)=>exclusive(queue,async()=>{
      const i=intent.parse({employmentId,requestId}),s=await read();
      if(s.key){await release(s.key);return status(s);}
      if(s.pending){if(s.pending.employmentId!==i.employmentId)throw new EnrollmentConflict();return status(s);}
      return status(await save(s,{...i,phase:'requested'}));
    }),
    advance:(employmentId:string)=>exclusive(queue,async()=>{
      const selected=uuid.parse(employmentId);let s=await read(),p=s.pending;
      if(!p){if(s.key)await release(s.key);return status(s);}
      if(p.employmentId!==selected)throw new EnrollmentConflict();
      const intentRef={employmentId:p.employmentId,requestId:p.requestId};
      let refreshed=false,reconciled=false;
      for(let steps=0;steps<8;steps++){
        ports.assertCurrent();
        if(p.phase==='requested'){
          const value=checked(C.IntegrityEnrollmentPrepared,await owned(()=>ports.prepare(intentRef.employmentId,{requestId:intentRef.requestId,appInstallationId:scope.appInstallationId})));
          if(value.outcome!=='prepared')return status(s,value.outcome==='refused'?'server_refused':'server_unavailable');
          await checkPrepared(value,p);p={...p,phase:'prepared',prepared:value};s=await save(s,p);refreshed=true;
        }
        await checkPrepared(p.prepared,p);
        const preparedRef:Prepared=p.prepared;
        if(!reconciled){
          const lookup=checked(C.IntegrityKeyLookupResult,await owned(()=>ports.receipt(intentRef.employmentId,{originChallengeId:preparedRef.context.challengeId})));
          if(lookup.outcome!=='key_receipt')return status(s,lookup.outcome==='refused'?'server_refused':'server_unavailable');
          const found=lookup.key;
          if(found&&!receiptMatches(found,p.prepared))throw new EnrollmentConflict();
          if(found){
            const reference=await keyReference(p.prepared);if('reason' in reference)return status(s,reference.reason);const {vendorKeyId}=reference;
            if('vendorKeyId' in p&&p.vendorKeyId!==vendorKeyId)throw new EnrollmentConflict();
            return registered(s,{employmentId:p.employmentId,requestId:p.requestId,prepared:p.prepared,vendorKeyId,key:found});
          }
          reconciled=true;
        }
        if(p.phase==='proof_ready'){
          // An absent lookup is not terminal: a concurrent completion may still commit. Replay only
          // these exact saved bytes; the authoritative receipt owner reconciles before re-verification.
          const proof=p;
          const value=checked(C.IntegrityEnrollmentResult,await owned(()=>ports.complete(intentRef.employmentId,{requestId:intentRef.requestId,appInstallationId:scope.appInstallationId,
            challengeId:preparedRef.context.challengeId,vendorKeyId:proof.vendorKeyId,attestation:proof.attestation})));
          if(value.outcome!=='enrolled')return status(s,value.outcome==='refused'?'server_refused':'server_unavailable');
          if(!receiptMatches(value.key,p.prepared))throw new EnrollmentConflict();
          return registered(s,{employmentId:p.employmentId,requestId:p.requestId,prepared:p.prepared,vendorKeyId:p.vendorKeyId,key:value.key});
        }
        if(!refreshed){
          const value=checked(C.IntegrityEnrollmentPrepared,await owned(()=>ports.prepare(intentRef.employmentId,{requestId:intentRef.requestId,appInstallationId:scope.appInstallationId})));
          if(value.outcome!=='prepared')return status(s,value.outcome==='refused'?'server_refused':'server_unavailable');
          await checkPrepared(value,p);
          if(keyEnrollmentClientData(value.context)!==keyEnrollmentClientData(p.prepared.context)||value.alias!==p.prepared.alias||value.clientDataHash!==p.prepared.clientDataHash)throw new EnrollmentConflict();
          p={...p,prepared:value};s=await save(s,p);refreshed=true;
        }
        if(p.prepared.state!=='active')return status(s,'challenge_unavailable');
        const capability=ports.native.capabilities();ports.assertCurrent();
        if(capability.status!=='evidence'||capability.evidence.platform!=='ios'||capability.evidence.keyMechanism!=='apple_app_attest')return status(s,'unsupported');
        if(capability.evidence.appId!==p.prepared.context.target.appId.slice(11))throw new EnrollmentConflict();
        const required=p.prepared.context.target.requiredMetadata;
        if(required&&!required.bundleVersions.includes(capability.evidence.buildVersion))return status(s,'unsupported');
        if(p.phase==='prepared'){
          // Require the recovery method before generating any key on an older native binary.
          if(!ports.native.appleProofRecoverySupported())return status(s,'unsupported');
          p={...p,phase:'key_requested'};s=await save(s,p);
          const value=await owned(()=>ports.native.generateAppleKey(preparedRef.alias));
          if(value.status!=='evidence')return status(s,nativeReason(value));
          p={...p,phase:'key_ready',vendorKeyId:checked(hash32,value.evidence)};s=await save(s,p);continue;
        }
        if(p.phase==='key_requested'){
          const reference=await keyReference(p.prepared);if('reason' in reference)return status(s,reference.reason);const {vendorKeyId}=reference;
          p={...p,phase:'key_ready',vendorKeyId};s=await save(s,p);continue;
        }
        const vendorKeyId:string=p.vendorKeyId;
        const cache=await owned(()=>ports.native.appleAttestationInfo(vendorKeyId,preparedRef.clientDataHash));
        if(cache.status!=='evidence')return status(s,nativeReason(cache));
        if(cache.evidence.state==='completed'){
          p={...p,phase:'proof_ready',attestation:checked(artifact,cache.evidence.attestation)};s=await save(s,p);continue;
        }
        if(cache.evidence.state==='released'||cache.evidence.state==='requested'||cache.evidence.state==='absent'&&p.phase==='attestation_requested')return status(s,'recovery_required');
        p={...p,phase:'attestation_requested'};s=await save(s,p);
        const value=await owned(()=>ports.native.attestAppleKey(vendorKeyId,preparedRef.clientDataHash));
        if(value.status!=='evidence')return status(s,nativeReason(value));
        p={...p,phase:'proof_ready',attestation:checked(artifact,value.evidence)};s=await save(s,p);
      }
      throw new EnrollmentJournalUnavailable();
    }),
  };
}
