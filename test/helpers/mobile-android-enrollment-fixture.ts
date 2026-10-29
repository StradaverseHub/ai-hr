/** Synthetic server/SDK ports for the real durable model. Never a hardware acceptance fixture. */
import {createHash} from 'node:crypto';
import {vi} from 'vitest';
import type {z} from 'zod';
import * as C from '../../lib/mobile-integrity-contract';
import {AndroidEnrollmentContext,AndroidEnrollmentPreparation,androidEnrollmentClientData,androidEnrollmentAliasData,androidNativeKeyReferenceData} from '../../lib/mobile-android-enrollment';
import {nativeKeyBindingData} from '../../lib/mobile-key-enrollment';
import {createAndroidEnrollmentJournal,type AndroidEnrollmentPorts,type AndroidEnrollmentSnapshot} from '../../mobile/lib/android-enrollment-journal';
import {SessionChangedError} from '../../mobile/lib/errors';
export const androidEnrollmentId=(n:number)=>`${String(n).padStart(8,'0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
export function androidEnrollmentFixture(){
 const id=androidEnrollmentId,scope={namespace:'android-company-one',apiOrigin:'https://hr.example.com',actorId:id(3),appInstallationId:id(5)},employmentId=id(4),requestId=id(6);
 const context=AndroidEnrollmentContext.parse({version:1,purpose:'device.key.enrollment',apiOrigin:scope.apiOrigin,installationId:id(1),tenantId:id(2),actorId:scope.actorId,employmentId,appInstallationId:scope.appInstallationId,requestId,challengeId:id(7),nonce:'A'.repeat(43),issuedAt:1800000000000,expiresAt:1800000600000,target:{platform:'android',packageName:'ai.stradaverse.aihr.test',certificateDigests:[Buffer.alloc(32,1).toString('base64')],versionCodes:['4'],securityLevels:['tee'],provisioningMetadata:'allow_legacy',minimumOsVersion:null,minimumOsPatchLevel:null,minimumVendorPatchLevel:null,minimumBootPatchLevel:null}});
 const hash=(value:string,encoding:'hex'|'base64')=>createHash('sha256').update(value).digest(encoding);
 let stored:AndroidEnrollmentSnapshot|null=null,generation=0;
 const records=new Map<string,z.infer<typeof C.IntegrityAndroidKeyReceipt>>(),preparations=new Map<string,z.infer<typeof C.IntegrityAndroidEnrollmentPrepared.options[0]>>();
 const keys=new Map<string,{publicKeySpki:string;certificateChain:string[];reportedSecurityLevel:'unknown'}>(),events:string[]=[];
 function prepared(request=requestId,employment=employmentId){
  let value=preparations.get(request);if(!value){const c={...context,requestId:request,employmentId:employment,challengeId:request===requestId?id(7):id(100+preparations.size)};
   value={outcome:'prepared',protocol:2,state:'active',context:c,clientDataHash:hash(androidEnrollmentClientData(c),'base64'),alias:'aihr_'+hash(androidEnrollmentAliasData(c),'hex')};preparations.set(request,value);}
  return structuredClone(value);
 }
 function installKey(alias:string){let artifact=keys.get(alias);if(!artifact){artifact={publicKeySpki:Buffer.alloc(91,keys.size+1).toString('base64'),certificateChain:[Buffer.from('private-synthetic-leaf').toString('base64'),Buffer.from('synthetic-issuer').toString('base64')],reportedSecurityLevel:'unknown'};keys.set(alias,artifact);}return structuredClone(artifact);}
 function makeReceipt(challengeId:string,publicKeySpki:string){
  const reference=hash(androidNativeKeyReferenceData(publicKeySpki),'base64');
  return C.IntegrityAndroidKeyReceipt.parse({keyId:id(500+records.size),originChallengeId:challengeId,platform:'android',appId:context.target.packageName,environment:null,proofKind:'google_key_generation_proof',nativeKeyBinding:hash(nativeKeyBindingData(challengeId,reference),'hex'),createdAt:'2026-10-27T00:00:00.000Z',revokedAt:null});
 }
 const native={
  create:vi.fn<AndroidEnrollmentPorts['native']['create']>(async(input,persist)=>{
   const p=AndroidEnrollmentPreparation.parse(input);await persist(p);
   events.push('sdk-create');if(keys.has(p.alias))return {status:'invalid',reason:'key_exists'};
   return {status:'evidence',evidence:installKey(p.alias),verification:'not_verified'};
  }),
  read:vi.fn<AndroidEnrollmentPorts['native']['read']>(async input=>{
   const p=AndroidEnrollmentPreparation.parse(input);events.push('sdk-read');const artifact=keys.get(p.alias);
   return artifact?{status:'evidence',evidence:structuredClone(artifact),verification:'not_verified'}:{status:'invalid',reason:'invalid_key'};
  }),
 };
 const ports:AndroidEnrollmentPorts={assertCurrent:()=>{if(generation!==0)throw new SessionChangedError();},native,
  read:vi.fn(async()=>stored?structuredClone(stored):null),commit:vi.fn(async value=>{events.push('commit:'+String(value.pending?.phase??(value.version===2?'revoking':'registered')));stored=structuredClone(value);}),
  digest:vi.fn(async(value,encoding)=>hash(value,encoding)),
  prepare:vi.fn(async(employment,input)=>{events.push('prepare');return prepared(input.requestId,employment);}),
  receipt:vi.fn(async(_employment,input)=>{events.push('receipt');return {outcome:'key_receipt',key:structuredClone(records.get(input.originChallengeId)??null)};}),
  complete:vi.fn(async(_employment,input)=>{
   const proof=C.IntegrityAndroidEnrollmentProof.parse(input);events.push('complete');
   const key=records.get(proof.challengeId)??makeReceipt(proof.challengeId,proof.publicKeySpki);records.set(proof.challengeId,key);return {outcome:'enrolled',key:structuredClone(key)};
  }),
  revoke:vi.fn(async(_employment,input)=>{
   events.push('revoke');const key=[...records.values()].find(value=>value.keyId===input.keyId);if(!key)return {outcome:'refused',code:'key_unavailable'};
   key.revokedAt??='2026-10-28T00:00:00.000Z';return {outcome:'revoked',key:structuredClone(key)};
  }),
 };
 return {scope,employmentId,requestId,context,ports,native,keys,records,events,prepared,installKey,makeReceipt,
  stored:()=>stored?structuredClone(stored):null,setStored:(value:AndroidEnrollmentSnapshot|null)=>{stored=structuredClone(value);},changeOwner:()=>{generation++;},
  journal:()=>{const owner=generation;return createAndroidEnrollmentJournal(scope,{...ports,assertCurrent:()=>{if(generation!==owner)throw new SessionChangedError();}});},
 };
}
