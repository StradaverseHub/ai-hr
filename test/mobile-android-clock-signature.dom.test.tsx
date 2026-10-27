/** Synthetic P256 signatures prove canonical byte binding; no Android hardware/key custody is claimed. */
import {createHash,generateKeyPairSync,sign} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {checkAndroidClockSignature} from '../lib/mobile-api/android-clock-signature';
import {onlineClockClientData} from '../lib/mobile-clock-integrity';
const id=(n:number)=>`${String(n).padStart(8,'0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
function data(){return {version:1,purpose:'attendance.clock.online',scope:{apiOrigin:'https://hr.example.com',installationId:id(1),tenantId:id(2),actorId:id(3),employmentId:id(4),deviceKeyId:id(5)},
 challenge:{id:id(6),nonce:'A'.repeat(43),expiresAt:1800000060000},command:{requestId:id(7),action:'in',lat:3,lng:101,accuracy:5,sampledAt:1800000000000,photo:{sha256:'a'.repeat(64),byteLength:100,mimeType:'image/jpeg'}},
 evidence:{platform:'android',appId:'ai.stradaverse.aihr.test',appVersion:'1.0',buildVersion:'4',provider:'fused',mock:null,simulated:null,accessory:null}};}
function fixture(){const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),clientData=data();
 const signature=sign('sha256',Buffer.from(onlineClockClientData(clientData),'utf8'),privateKey);
 return {input:{publicKey,signature,clientData,expectedAppId:clientData.evidence.appId,allowedBuildVersions:['4']},privateKey};}
function refusal(f:ReturnType<typeof fixture>,clientData:unknown){expect(()=>checkAndroidClockSignature({...f.input,clientData})).toThrow();}
describe('Android canonical online command signatures',()=>{
 it('verifies SHA256withECDSA over UTF8 command bytes, never double-hashed or caller digests',()=>{
  const f=fixture(),bytes=Buffer.from(onlineClockClientData(f.input.clientData),'utf8');
  expect(checkAndroidClockSignature(f.input)).toEqual({verification:'command_signature',clientDataHash:createHash('sha256').update(bytes).digest('hex')});
  const signature=sign('sha256',createHash('sha256').update(bytes).digest(),f.privateKey);
  expect(()=>checkAndroidClockSignature({...f.input,signature})).toThrow(expect.objectContaining({reason:'invalid_signature'}));
 });
 it('binds every actor/tenant/install/employment/key and challenge fact',()=>{
  const f=fixture(),original=f.input.clientData;
  for(const key of ['installationId','tenantId','actorId','employmentId','deviceKeyId'])refusal(f,{...original,scope:{...original.scope,[key]:id(9)}});
  refusal(f,{...original,scope:{...original.scope,apiOrigin:'https://other.example.com'}});
  for(const change of [{id:id(9)},{nonce:'B'+'A'.repeat(42)},{expiresAt:1800000060001}])refusal(f,{...original,challenge:{...original.challenge,...change}});
 });
 it('binds request/action/location/uncertainty/sample/photo and preserves null distinct from false',()=>{
  const f=fixture(),original=f.input.clientData;
  for(const change of [{requestId:id(9)},{action:'out'},{lat:3.01},{lng:101.01},{accuracy:6},{sampledAt:1800000000001},{photo:null},
   {photo:{...original.command.photo,sha256:'b'.repeat(64)}},{photo:{...original.command.photo,byteLength:101}},{photo:{...original.command.photo,mimeType:'image/png'}}])refusal(f,{...original,command:{...original.command,...change}});
  for(const change of [{provider:null},{mock:false},{simulated:false},{accessory:false},{appVersion:'1.1'},{buildVersion:'5'}])refusal(f,{...original,evidence:{...original.evidence,...change}});
 });
 it('does not trust a different key, platform, app or build identity even with a valid signature',()=>{
  const f=fixture(),other=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  expect(()=>checkAndroidClockSignature({...f.input,publicKey:other.publicKey})).toThrow(expect.objectContaining({reason:'invalid_signature'}));
  for(const changed of [{platform:'ios'},{appId:'other.app'},{buildVersion:'5'}]){
   const clientData={...f.input.clientData,evidence:{...f.input.clientData.evidence,...changed}},signature=sign('sha256',Buffer.from(onlineClockClientData(clientData)),f.privateKey);
   expect(()=>checkAndroidClockSignature({...f.input,clientData,signature})).toThrow(expect.objectContaining({reason:'wrong_app'}));
  }
 });
 it('canonicalizes property order and UUID case while refusing unsupported domains and caller-only authority',()=>{
  const f=fixture(),original=f.input.clientData;
  expect(checkAndroidClockSignature({...f.input,clientData:{...Object.fromEntries(Object.entries(original).reverse()),scope:{...original.scope,actorId:original.scope.actorId.toUpperCase()}}})).toMatchObject({verification:'command_signature'});
  for(const change of [{version:2},{purpose:'attendance.clock.offline'},{verified:true},{scope:{...original.scope,apiOrigin:'https://hr.example.com/path'}}])refusal(f,{...original,...change});
 });
 it('rejects private/RSA/wrong-curve keys and invalid deployment targets',()=>{
  const f=fixture();for(const publicKey of [f.privateKey,generateKeyPairSync('ec',{namedCurve:'secp384r1'}).publicKey,generateKeyPairSync('rsa',{modulusLength:2048}).publicKey])
   expect(()=>checkAndroidClockSignature({...f.input,publicKey})).toThrow(expect.objectContaining({reason:'invalid_key'}));
  for(const change of [{expectedAppId:'ai.hr\n'},{allowedBuildVersions:[]},{allowedBuildVersions:['04']},{allowedBuildVersions:Array(21).fill('4')},{allowedBuildVersions:['18446744073709551616']}])expect(()=>checkAndroidClockSignature({...f.input,...change})).toThrow(expect.objectContaining({reason:'configuration'}));
 });
 it('bounds DER and refuses truncation, appended data, zero/negative/out-of-order scalars and P1363',()=>{
  const f=fixture();const bytes=Buffer.from(onlineClockClientData(f.input.clientData));
  const p1363=sign('sha256',bytes,{key:f.privateKey,dsaEncoding:'ieee-p1363'});
  for(const signature of [Buffer.alloc(0),Buffer.alloc(73),p1363,Buffer.concat([f.input.signature,Buffer.from([0])]),
   Buffer.from('3006020100020101','hex'),Buffer.from('3006020180020101','hex'),Buffer.from('300702020001020101','hex'),
   Buffer.from('3026022100ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551020101','hex')])expect(()=>checkAndroidClockSignature({...f.input,signature})).toThrow();
  for(let length=0;length<f.input.signature.length;length++)expect(()=>checkAndroidClockSignature({...f.input,signature:f.input.signature.subarray(0,length)})).toThrow();
 });
 it('does not present signature validation as a one-use receipt, time, GPS or attendance decision',()=>{
  const f=fixture(),first=checkAndroidClockSignature(f.input),second=checkAndroidClockSignature(f.input);
  expect(second).toEqual(first);for(const field of ['accepted','nextCounter','presence','recordedAt','trustTier'])expect(first).not.toHaveProperty(field);
 });
});
