/** Native-model ports only. Server enrollment success and OS storage are synthetic in this fixture. */
import {createHash} from 'node:crypto';
import {vi} from 'vitest';
import {createEnrollmentJournal,type EnrollmentSnapshot,type EnrollmentPorts} from '../../mobile/lib/enrollment-journal';
import {createIntegrityBridge} from '../../mobile/lib/integrity-bridge';
import {keyEnrollmentClientData,type KeyEnrollmentContext} from '../../lib/mobile-key-enrollment';
import {SessionChangedError} from '../../mobile/lib/errors';
export const enrollmentId=(n:number)=>`${String(n).padStart(8,'0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
export function enrollmentFixture(){
  const scope={namespace:'synthetic connection',apiOrigin:'https://hr.example.com',actorId:enrollmentId(1),appInstallationId:enrollmentId(2)};
  const employmentId=enrollmentId(3),requestId=enrollmentId(4),vendorKeyId=Buffer.alloc(32,7).toString('base64'),attestation=Buffer.from('synthetic native proof').toString('base64');
  let current=true,stored:EnrollmentSnapshot|null=null,keyRef:string|null=null,cache:{state:'absent'|'requested'|'retryable'|'released'}|{state:'completed';attestation:string}={state:'absent'};
  let accepted=false,revoked=false,serverState:'active'|'expired'|'consumed'='active';
  const context:KeyEnrollmentContext={version:1,purpose:'device.key.enrollment',apiOrigin:scope.apiOrigin,installationId:enrollmentId(5),tenantId:enrollmentId(6),actorId:scope.actorId,
    employmentId,appInstallationId:scope.appInstallationId,requestId,challengeId:enrollmentId(7),nonce:'A'.repeat(43),issuedAt:1800000000000,expiresAt:1800000600000,
    target:{platform:'ios' as const,appId:'ABCDEFGHIJ.ai.stradaverse.aihr.test',environment:'production' as const,requiredMetadata:null}};
  const digest=async(value:string,encoding:'hex'|'base64')=>createHash('sha256').update(value,'utf8').digest(encoding);
  const prepared=()=>({outcome:'prepared',protocol:1,context:structuredClone(context),state:serverState,
    clientDataHash:createHash('sha256').update(keyEnrollmentClientData(context)).digest('base64'),
    alias:'aihr_'+createHash('sha256').update(JSON.stringify(['aihr-key-alias',1,context.installationId,context.tenantId,context.actorId,context.appInstallationId,context.challengeId])).digest('hex')});
  const receipt=()=>({keyId:enrollmentId(8),originChallengeId:context.challengeId,platform:'ios',appId:context.target.appId,environment:'production',proofKind:'apple_key_proof',
    nativeKeyBinding:createHash('sha256').update(JSON.stringify(['aihr.native-key-binding',1,context.challengeId,vendorKeyId])).digest('hex'),
    createdAt:'2026-10-27T00:00:00.000Z',revokedAt:revoked?'2026-10-28T00:00:00.000Z':null});
  const check=()=>{if(!current)throw new SessionChangedError();};
  const native={
    capabilities:vi.fn(()=>({version:1,platform:'ios',appId:'ai.stradaverse.aihr.test',appVersion:'1.0',buildVersion:'4',keyMechanism:'apple_app_attest'})),
    clockSnapshot:vi.fn(()=>null),
    appleKeyInfo:vi.fn(async(_alias:string)=>keyRef),
    generateAppleKey:vi.fn(async(_alias:string)=>{keyRef=vendorKeyId;return vendorKeyId;}),
    appleAttestationInfo:vi.fn(async(_key:string,_hash:string)=>structuredClone(cache)),
    releaseAppleAttestation:vi.fn(async(_key:string,_hash:string)=>{cache={state:'released'};return null;}),
    resetAppleIntegrityInstallation:vi.fn(async()=>null),
    attestAppleKey:vi.fn(async(_key:string,_hash:string)=>{cache={state:'completed',attestation};return attestation;}),
    assertAppleKey:vi.fn(async()=>null),createAndroidKey:vi.fn(async()=>null),androidKeyInfo:vi.fn(async()=>null),signAndroidCommand:vi.fn(async()=>null),preparePlayIntegrity:vi.fn(async()=>null),requestPlayIntegrity:vi.fn(async()=>null),
  };
  const ports:EnrollmentPorts={assertCurrent:check,digest,native:createIntegrityBridge(native,check),
    read:vi.fn(async()=>structuredClone(stored)),commit:vi.fn(async(value)=>{stored=structuredClone(value);}),
    prepare:vi.fn(async()=>prepared()),keys:vi.fn(async()=>({outcome:'keys',items:accepted?[receipt()]:[]})),
    complete:vi.fn(async()=>{accepted=true;return {outcome:'enrolled',key:receipt()};}),
  };
  return {scope,employmentId,requestId,vendorKeyId,attestation,native,ports,context,prepared,receipt,
    journal:()=>createEnrollmentJournal(scope,ports),stored:()=>structuredClone(stored),setStored:(s:EnrollmentSnapshot|null)=>{stored=structuredClone(s);},
    setCache:(value:typeof cache)=>{cache=value;},setKey:(value:string|null)=>{keyRef=value;},setAccepted:(value:boolean)=>{accepted=value;},
    setRevoked:(value:boolean)=>{revoked=value;},setServerState:(value:typeof serverState)=>{serverState=value;},changeOwner:()=>{current=false;}};
}
