/** Multi-key synthetic native/server ports. No Apple hardware proof or live custody claim. */
import {createHash} from 'node:crypto';
import {vi} from 'vitest';
import * as C from '../../lib/mobile-integrity-contract';
import {keyEnrollmentClientData,nativeKeyBindingData} from '../../lib/mobile-key-enrollment';
import {createEnrollmentJournal,type EnrollmentPorts} from '../../mobile/lib/enrollment-journal';
import {createIntegrityBridge} from '../../mobile/lib/integrity-bridge';
import {enrollmentFixture,enrollmentId as id} from './mobile-enrollment-fixture';
export function appleReplacementFixture(){
 const base=enrollmentFixture(),keys=new Map<string,string>(),cache=new Map<string,{hash:string;state:'completed'|'released';attestation:string}>();
 const prepared=new Map<string,ReturnType<typeof base.prepared>>(),receipts=new Map<string,ReturnType<typeof C.IntegrityKeyReceipt.parse>>();
 const hash=(value:string,encoding:'hex'|'base64')=>createHash('sha256').update(value).digest(encoding);
 const native={...base.native,
  appleKeyInfo:vi.fn(async(alias:string)=>keys.get(alias)??null),
  generateAppleKey:vi.fn(async(alias:string)=>{const key=hash(alias,'base64');keys.set(alias,key);return key;}),
  appleAttestationInfo:vi.fn(async(key:string,digest:string)=>{const record=cache.get(key);if(!record)return {state:'absent'};if(record.hash!==digest)throw new Error('hash conflict');return record.state==='released'?{state:'released'}:{state:'completed',attestation:record.attestation};}),
  attestAppleKey:vi.fn(async(key:string,digest:string)=>{if(cache.has(key))throw new Error('one-use operation repeated');const attestation=Buffer.from('synthetic:'+key).toString('base64');cache.set(key,{hash:digest,state:'completed',attestation});return attestation;}),
  releaseAppleAttestation:vi.fn(async(key:string,digest:string)=>{const record=cache.get(key);if(record){if(record.hash!==digest)throw new Error('hash conflict');record.state='released';}return null;}),
 };
 const ports:EnrollmentPorts={...base.ports,native:createIntegrityBridge(native,base.ports.assertCurrent),
  prepare:vi.fn(async(employmentId,input)=>{
   let value=prepared.get(input.requestId);
   if(!value){const context={...base.context,requestId:input.requestId,employmentId,challengeId:id(100+prepared.size)};
    value={outcome:'prepared',protocol:1,state:'active',context,clientDataHash:hash(keyEnrollmentClientData(context),'base64'),
     alias:'aihr_'+hash(JSON.stringify(['aihr-key-alias',1,context.installationId,context.tenantId,context.actorId,context.appInstallationId,context.challengeId]),'hex')};prepared.set(input.requestId,value);}
   return structuredClone(value);
  }),
  complete:vi.fn(async(_employmentId,input)=>{
   let key=receipts.get(input.challengeId);
   if(!key){key=C.IntegrityKeyReceipt.parse({keyId:id(500+receipts.size),originChallengeId:input.challengeId,platform:'ios',appId:base.context.target.appId,environment:'production',proofKind:'apple_key_proof',
    nativeKeyBinding:hash(nativeKeyBindingData(input.challengeId,input.vendorKeyId),'hex'),createdAt:'2026-10-27T00:00:00.000Z',revokedAt:null});receipts.set(input.challengeId,key);}
   return {outcome:'enrolled',key:structuredClone(key)};
  }),
  receipt:vi.fn(async(_employmentId,input)=>({outcome:'key_receipt',key:structuredClone(receipts.get(input.originChallengeId)??null)})),
  revoke:vi.fn(async(_employmentId,input)=>{const key=[...receipts.values()].find(value=>value.keyId===input.keyId);if(!key)return {outcome:'refused',code:'key_unavailable'};
   key.revokedAt??='2026-10-28T00:00:00.000Z';return {outcome:'revoked',key:structuredClone(key)};}),
 };
 return {...base,native,ports,keys,cache,receipts,prepared,journal:()=>createEnrollmentJournal(base.scope,ports)};
}
