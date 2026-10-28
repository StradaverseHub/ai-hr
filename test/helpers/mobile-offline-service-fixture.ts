/** Real enrollment/context owners, synthetic vendor proof and an explicit test snapshot unless a caller passes a port.
 * `prepare` runs after enrollment and before issuance, so a caller can shape what a real snapshot port reads. `issue`
 * replaces the fixture's own issuance service (e.g. the mounted HTTP route); it must return the exact signed bytes. */
import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign} from 'node:crypto';
import cbor from 'cbor';
import {eq} from 'drizzle-orm';
import type {SessionContext} from '../../db/client';
import * as S from '../../db/schema';
import {hireEmployee} from '../../core/org';
import {createAppleEnrollmentService} from '../../core/mobile-apple-enrollment';
import {createAndroidEnrollmentService} from '../../core/mobile-android-enrollment';
import {createOfflineContextIssueService,type OfflineContextIssuePorts,type OfflineContextSnapshot} from '../../core/mobile-offline-context';
import {offlineContextIssuerIdentity} from '../../lib/mobile-api/offline-context-signature';
import {OfflineClockClaimData,offlineClockClaimClientData} from '../../lib/mobile-offline-clock';
import {OfflineClockContextEnvelope,offlineClockContextClientData} from '../../lib/mobile-offline-context';
import {adminCtx,createAppUser,harnessSnapshot,owner,type Base} from '../harness';
export async function offlineServiceFixture(base:Base,platform:'ios'|'android'='ios',options:{snapshot?:OfflineContextIssuePorts['snapshot'];prepare?:(employmentId:string)=>Promise<void>;
 issue?:(ctx:SessionContext,input:{employmentId:string;request:{requestId:string;requestNonce:string;appInstallationId:string;keyId:string}})=>Promise<{raw:string}>}={}){
 const e=await hireEmployee(adminCtx(base),{person:{fullName:'Offline consumer employee',primaryEmail:randomUUID()+'@consume.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'}),userId=await createAppUser(base.tenantId,e.personId,'employee');
 const ctx:SessionContext={tenantId:base.tenantId,userId,personId:e.personId,roles:['employee'],grants:[{role:'employee',companyId:base.companyId}],entitlements:harnessSnapshot(base.tenantId)};
 const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),intent={employmentId:e.employmentId,requestId:randomUUID(),appInstallationId:randomUUID()};let keyId:string;
 if(platform==='ios'){
  const appId='ABCDEFGHIJ.ai.hr',settings={apiOrigin:'https://hr.example.com',target:{platform:'ios',appId,environment:'production',requiredMetadata:null}},jwk=pair.publicKey.export({format:'jwk'}),vendorKeyId=createHash('sha256').update(Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')])).digest('base64');
  const enroll=createAppleEnrollmentService(settings,{verifyProof:async()=>({publicKey:pair.publicKey,keyId:vendorKeyId,environment:'production',metadata:{status:'unavailable'},receipt:Buffer.from('synthetic'),receiptVerification:'not_checked',revocation:'not_checked'})});
  const begin=await enroll.begin(ctx,intent);keyId=(await enroll.complete(ctx,{...intent,challengeId:begin.challenge.id,vendorKeyId,attestation:Buffer.from('synthetic')})).keyId;
 }else{
  const settings={apiOrigin:'https://hr.example.com',target:{platform:'android',packageName:'ai.hr',certificateDigests:[Buffer.alloc(32,1).toString('base64')],versionCodes:['4'],securityLevels:['tee'],provisioningMetadata:'allow_legacy',minimumOsVersion:null,minimumOsPatchLevel:null,minimumVendorPatchLevel:null,minimumBootPatchLevel:null}};
  const enroll=createAndroidEnrollmentService(settings,{verifyProof:async()=>({verification:'google_key_generation_proof',publicKey:pair.publicKey,checkedAt:Date.now(),packageName:'ai.hr',versionCode:'4',securityLevel:'tee',provisioning:'remote',provisioningEntity:'unavailable',lostDeviceStatus:'unavailable',factoryExpiryException:false,osVersion:160000,osPatchLevel:202610,vendorPatchLevel:20261001,bootPatchLevel:20261001})});
  const begin=await enroll.begin(ctx,intent);keyId=(await enroll.complete(ctx,{...intent,challengeId:begin.challenge.id,publicKeySpki:pair.publicKey.export({format:'der',type:'spki'}),certificateChain:[Buffer.from('synthetic leaf'),Buffer.from('synthetic issuer')]})).keyId;
 }
 const [key]=await owner.db.select().from(S.mobileIntegrityKey).where(eq(S.mobileIntegrityKey.id,keyId)),issuerPair=generateKeyPairSync('ed25519'),identity=offlineContextIssuerIdentity(issuerPair.privateKey);
 const settings={apiOrigin:'https://hr.example.com',privateKey:issuerPair.privateKey,issuer:{...identity,validFrom:Date.now()-86400000,validUntil:Date.now()+86400000,revoked:false},maximumIssuesPerHour:4};
 const snapshot:OfflineContextSnapshot={policy:{revision:'a'.repeat(64),offlineEnabled:true,windowMs:3600000,geofencingRequired:false,maximumAccuracyM:null,photoRequirement:'optional'},sites:[],attendance:{baseline:'b'.repeat(64),date:'2026-10-27',clockedIn:false,openSince:null},target:platform==='ios'?{platform,appId:'ABCDEFGHIJ.ai.hr',environment:'production'}:{platform,appId:'ai.hr',environment:null},permitCount:2};
 await options.prepare?.(e.employmentId);
 const request={employmentId:e.employmentId,request:{requestId:randomUUID(),requestNonce:randomBytes(32).toString('base64url'),appInstallationId:intent.appInstallationId,keyId}};
 const issued=options.issue?await options.issue(ctx,request):await createOfflineContextIssueService(settings,{snapshot:options.snapshot??(async()=>snapshot),beforeCommit:async()=>{}}).issue(ctx,request),{context}=OfflineClockContextEnvelope.parse(JSON.parse(issued.raw));
 const claim:OfflineClockClaimData={version:1,purpose:'attendance.clock.offline.claim',scope:context.scope,context:{id:context.id,sha256:createHash('sha256').update(offlineClockContextClientData(context)).digest('hex')},permit:context.permits[0],chain:{sequence:1,previousSha256:null},
  command:{requestId:randomUUID(),action:'out',lat:3,lng:101,accuracy:5,sampledAt:context.issuedAt,photo:null},time:{claimedAt:context.issuedAt,elapsed:{status:'elapsed',minimumNs:'0',maximumNs:'1000000000',continuity:'same_process'}},evidence:{platform,appId:'ai.hr',appVersion:'1',buildVersion:'4',provider:null,mock:null,simulated:null,accessory:null}};
 function signed(input=claim,counter=input.chain.sequence){
  const bytes=Buffer.from(offlineClockClaimClientData(input));
  if(platform==='android')return {claim:input,proof:{platform,signature:sign('sha256',bytes,pair.privateKey).toString('base64')}};
  const auth=Buffer.alloc(37);createHash('sha256').update(key.appId).digest().copy(auth);auth.writeUInt32BE(counter,33);
  const nonce=createHash('sha256').update(auth).update(createHash('sha256').update(bytes).digest()).digest();
  return {claim:input,proof:{platform,assertion:cbor.encode({authenticatorData:auth,signature:sign('sha256',nonce,pair.privateKey)}).toString('base64')}};
 }
 return {ctx,e,key,pair,context,claim,signed,request,raw:issued.raw};
}
