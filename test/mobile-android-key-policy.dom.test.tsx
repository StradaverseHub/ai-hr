/** Pure policy mutations do not prove hardware. Composed cases use captured real certificate signatures. */
import {readFileSync} from 'node:fs';
import {X509Certificate} from 'node:crypto';
import {Certificate} from 'pkijs';
import {fromBER} from 'asn1js';
import cbor from 'cbor';
import {decodeAndroidProvisioningInfo} from '../lib/mobile-api/android-provisioning';
import {describe,expect,it,vi} from 'vitest';
import {decodeAndroidKeyDescription} from '../lib/mobile-api/android-key-description';
import {AndroidKeyPolicy,matchAndroidKeyPolicy,matchAndroidIssuerSignals} from '../lib/mobile-api/android-key-policy';
import {createAndroidKeyProofVerifier} from '../lib/mobile-api/android-key-proof';
const base='test/fixtures/mobile-integrity/android/';
function fixture(){
 const chain=readFileSync(base+'strongbox-2026.pem','utf8').match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g)!.map(value=>new X509Certificate(value).raw);
 const leaf=new X509Certificate(chain[0]),cert=new Certificate({schema:fromBER(new Uint8Array(chain[0])).result});
 const description=decodeAndroidKeyDescription(Buffer.from(cert.extensions!.find(value=>value.extnID==='1.3.6.1.4.1.11129.2.1.17')!.extnValue.getValue()));
 const settings={provisioningMetadata:'allow_legacy',packageName:'com.google.android.attestation',certificateDigests:['EDk47kU35Z6O55L2VFBPuDRvxrNG0LvEQV/DOfz8jsE='],versionCodes:['0'],securityLevels:['strongbox'],minimumOsVersion:160000,minimumOsPatchLevel:202602,minimumVendorPatchLevel:20260205,minimumBootPatchLevel:20260205};
 const input={certificateChain:chain,publicKeySpki:leaf.publicKey.export({type:'spki',format:'der'}),challenge:Buffer.from(description.challenge)};
 const now=Date.parse('2026-02-26T00:00:00Z'),revocation=vi.fn(async(serials:readonly string[])=>({status:'checked' as const,source:'google_https' as const,checkedAt:now,certificateCount:serials.length}));
 return {description,settings,input,ports:{now:()=>now,revocation}};
}
describe('Android key-generation policy',()=>{
 it('matches the captured app/build/signer and hardware facts only after real path validation',async()=>{
  const f=fixture(),verify=createAndroidKeyProofVerifier(f.settings,f.ports),proof=await verify(f.input);
  expect(proof).toMatchObject({verification:'google_key_generation_proof',packageName:f.settings.packageName,versionCode:'0',securityLevel:'strongbox',provisioning:'remote',osPatchLevel:202602});
  expect(proof).toMatchObject({provisioningEntity:'unavailable',lostDeviceStatus:'unavailable'});
  expect(proof).not.toHaveProperty('description');expect(proof).not.toHaveProperty('certificateDigests');expect(proof).not.toHaveProperty('accepted');
  const serialized=JSON.stringify(proof);expect(serialized).not.toContain('MyevYthK');
 });
 it('requires an explicit legacy-metadata decision and refuses missing fields when strict metadata is selected',async()=>{
  const f=fixture(),{provisioningMetadata,...missing}=f.settings;
  expect(()=>createAndroidKeyProofVerifier(missing,f.ports)).toThrow(expect.objectContaining({reason:'configuration'}));
  await expect(createAndroidKeyProofVerifier({...f.settings,provisioningMetadata:'require_entity_and_lost_device'},f.ports)(f.input)).rejects.toMatchObject({reason:'metadata_unavailable'});
 });
 it('cannot reinterpret a correctly signed proof as a different package, build, signer or hardware level',async()=>{
  for(const changed of [{packageName:'ai.stradaverse.aihr.test'},{versionCodes:['4']},{certificateDigests:[Buffer.alloc(32).toString('base64')]},{securityLevels:['tee']},{minimumOsPatchLevel:202603}]){
   const f=fixture();await expect(createAndroidKeyProofVerifier({...f.settings,...changed},f.ports)(f.input)).rejects.toThrow();
  }
 });
 it('refuses software or mismatched security levels even if ordinary hardware fields look valid',()=>{
  for(const levels of [['software','software'],['tee','strongbox'],['strongbox','software']]){
   const f=fixture(),d=structuredClone(f.description);d.attestationSecurityLevel=levels[0] as never;d.keyMintSecurityLevel=levels[1] as never;
   expect(()=>matchAndroidKeyPolicy(f.settings,d)).toThrow(expect.objectContaining({reason:'security_level'}));
  }
 });
 it('refuses shared UID, absent app ID, hardware app-ID substitution and any unexpected signing certificate',()=>{
  for(const change of ['absent','shared','hardware','signer','all-apps'] as const){
   const f=fixture(),d=structuredClone(f.description),app=d.softwareEnforced.applicationId!;
   if(change==='absent')d.softwareEnforced.applicationId=undefined;
   if(change==='shared')app.packages.push({name:'other.app',version:'0'});
   if(change==='hardware'){d.hardwareEnforced.applicationId=app;d.softwareEnforced.applicationId=undefined;}
   if(change==='signer')app.certificateDigests.push(Buffer.alloc(32).toString('base64'));
   if(change==='all-apps')d.hardwareEnforced.allApplications=true;
   expect(()=>matchAndroidKeyPolicy(f.settings,d)).toThrow(expect.objectContaining({reason:'app_identity'}));
  }
 });
 it('requires hardware-generated P256 signing with SHA256, never software authorization fallbacks',()=>{
  for(const changed of [{algorithm:1},{keySize:384},{curve:2},{origin:2},{purposes:[3]},{purposes:[2,7]},{digests:undefined},{digests:[4,5]}]){
   const f=fixture(),d=structuredClone(f.description);Object.assign(d.hardwareEnforced,changed);
   expect(()=>matchAndroidKeyPolicy(f.settings,d)).toThrow(expect.objectContaining({reason:'key_properties'}));
  }
  const f=fixture(),d=structuredClone(f.description);d.softwareEnforced.algorithm=3;
  expect(()=>matchAndroidKeyPolicy(f.settings,d)).toThrow(expect.objectContaining({reason:'key_properties'}));
 });
 it('requires locked verified boot and actual expected digest lengths without persisting identifiers',()=>{
  for(const changed of [{deviceLocked:false},{state:'self_signed'},{state:'unverified'},{bootKeyBytes:0},{bootHashBytes:0}]){
   const f=fixture(),d=structuredClone(f.description);Object.assign(d.hardwareEnforced.rootOfTrust!,changed);
   expect(()=>matchAndroidKeyPolicy(f.settings,d)).toThrow(expect.objectContaining({reason:'boot_state'}));
  }
 });
 it('does not silently substitute software/absent patch values for hardware minima',()=>{
  for(const key of ['osVersion','osPatchLevel','vendorPatchLevel','bootPatchLevel'] as const){
   const f=fixture(),d=structuredClone(f.description);d.softwareEnforced[key]=d.hardwareEnforced[key];d.hardwareEnforced[key]=undefined;
   expect(()=>matchAndroidKeyPolicy(f.settings,d)).toThrow(expect.objectContaining({reason:'patch_level'}));
  }
 });
 it('validates canonical deployment settings and never chooses a universal patch age or software fallback',()=>{
  const f=fixture();for(const value of [{...f.settings,securityLevels:['software']},{...f.settings,versionCodes:['01']},{...f.settings,certificateDigests:[f.settings.certificateDigests[0]+'\n']},{...f.settings,minimumOsPatchLevel:202613},{...f.settings,minimumVendorPatchLevel:20260230},{...f.settings,verified:true}])expect(()=>createAndroidKeyProofVerifier(value,f.ports)).toThrow(expect.objectContaining({reason:'configuration'}));
  const settings={...f.settings,minimumOsVersion:null,minimumOsPatchLevel:null,minimumVendorPatchLevel:null,minimumBootPatchLevel:null};
  expect(AndroidKeyPolicy.parse(settings)).toMatchObject({minimumBootPatchLevel:null});
 });
 it('refuses lost-device and issuer/key-level conflicts before policy can grant key-generation evidence',()=>{
  const f=fixture();
  expect(()=>matchAndroidIssuerSignals(f.description,'strongbox',true)).toThrow(expect.objectContaining({reason:'lost_device'}));
  expect(()=>matchAndroidIssuerSignals(f.description,'tee',false)).toThrow(expect.objectContaining({reason:'security_level'}));
  expect(()=>matchAndroidIssuerSignals(f.description,'strongbox',null)).not.toThrow();
  for(const changed of [{osPatchLevel:202699},{vendorPatchLevel:20260230},{bootPatchLevel:20261301}]){
   const d=structuredClone(f.description);Object.assign(d.hardwareEnforced,changed);
   expect(()=>matchAndroidKeyPolicy(f.settings,d)).toThrow(expect.objectContaining({reason:'patch_level'}));
  }
 });
 it('keeps legacy missing provisioning metadata unavailable and validates new known fields',()=>{
  expect(decodeAndroidProvisioningInfo(cbor.encode(new Map<number,number|string>([[1,32],[3,'Google']])))).toEqual({entity:null,lostDevice:null});
  expect(decodeAndroidProvisioningInfo(cbor.encode(new Map<any,any>([[1,32],[4,'STRONG_BOX'],[6,true]])))).toEqual({entity:'strongbox',lostDevice:true});
  expect(decodeAndroidProvisioningInfo(cbor.encode(new Map<any,any>([[1,32],[4,'TEE'],[6,false]])))).toEqual({entity:'tee',lostDevice:false});
  for(const map of [new Map<any,any>([[1,32],[4,'UNKNOWN']]),new Map<any,any>([[1,32],[6,'false']]),new Map<any,any>([[1,-1]]),new Map<any,any>([['1',32]])])expect(()=>decodeAndroidProvisioningInfo(cbor.encode(map))).toThrow();
  for(const bytes of [Buffer.alloc(2049),Buffer.from('a20101180102','hex'),Buffer.concat([cbor.encode(new Map([[1,32]])),Buffer.from([0])])])expect(()=>decodeAndroidProvisioningInfo(bytes)).toThrow();
 });
 it('snapshots validated server configuration before asynchronous verification',async()=>{
  const f=fixture(),verify=createAndroidKeyProofVerifier(f.settings,f.ports);f.settings.packageName='untrusted.change';f.settings.securityLevels.splice(0,1,'tee');
  expect(await verify(f.input)).toMatchObject({packageName:'com.google.android.attestation',securityLevel:'strongbox'});
 });
});
