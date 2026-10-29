/** Synthetic Google transport exercises the real decoder/policy, not physical-device evidence. */
import {randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {createAndroidClockIntegrityVerifier} from '../lib/mobile-api/android-clock-integrity';
import {AndroidClockIntegrityPolicy} from '../lib/mobile-android-clock-policy';
import {onlineClockClientDataHash} from '../lib/mobile-api/clock-integrity';
import type {OnlineClockIntegrityData} from '../lib/mobile-clock-integrity';

function fixture(){
 const now=Date.now(),pkg='ai.stradaverse.aihr.test',certificate=Buffer.alloc(32,1).toString('base64');
 const command:OnlineClockIntegrityData={version:1,purpose:'attendance.clock.online',
  scope:{apiOrigin:'https://hr.example.test',installationId:randomUUID(),tenantId:randomUUID(),actorId:randomUUID(),employmentId:randomUUID(),deviceKeyId:randomUUID()},
  challenge:{id:randomUUID(),nonce:'A'.repeat(43),expiresAt:now+30000},
  command:{requestId:randomUUID(),action:'in',lat:3,lng:101,accuracy:4,sampledAt:now,photo:null},
  evidence:{platform:'android',appId:pkg,appVersion:'1.0.3',buildVersion:'4',provider:null,mock:false,simulated:null,accessory:null},
 };
 const request={clientData:command,challengeIssuedAt:now-1000};
 const settings={apiOrigin:command.scope.apiOrigin,target:{platform:'android',packageName:pkg,certificateDigests:[certificate],versionCodes:['4'],securityLevels:['tee'],provisioningMetadata:'allow_legacy',minimumOsVersion:null,minimumOsPatchLevel:null,minimumVendorPatchLevel:null,minimumBootPatchLevel:null}};
 const policy:AndroidClockIntegrityPolicy={version:1,minimumDeviceIntegrity:'device',licensing:'licensed',maxTokenAgeMs:1000,allowedFutureSkewMs:0,
  locationSignals:{mock:'require_report',simulated:'deny_reported',accessory:'allow'}};
 const payload=()=>({tokenPayloadExternal:{requestDetails:{requestPackageName:pkg,requestHash:onlineClockClientDataHash(command).toString('base64url'),timestampMillis:String(now-200)},
  appIntegrity:{appRecognitionVerdict:'PLAY_RECOGNIZED',packageName:pkg,certificateSha256Digest:[certificate],versionCode:'4'},
  accountDetails:{appLicensingVerdict:'LICENSED'},deviceIntegrity:{deviceRecognitionVerdict:['MEETS_DEVICE_INTEGRITY']}}});
 const transport=vi.fn<typeof fetch>(async()=>Response.json(payload())),accessToken=vi.fn(async()=> 'synthetic-server-token');
 let time=now;const options={transport,now:()=>time};
 const verify=createAndroidClockIntegrityVerifier(settings,policy,accessToken,options);
 return {now,command,request,settings,policy,payload,transport,accessToken,verify,options,setTime:(value:number)=>{time=value;}};
}
describe('current Android clock evidence policy',()=>{
 it('returns bounded command/policy-bound eligibility without claiming key ownership or verified GPS',async()=>{
  const f=fixture(),result=await f.verify('synthetic-play-token',f.request);
  expect(result).toMatchObject({status:'eligible',assessment:{version:1,verification:'google_play_standard',
   clientDataHash:onlineClockClientDataHash(f.command).toString('hex'),checkedAt:f.now,requestedAt:f.now-200,
   licensing:'LICENSED',deviceLabels:['MEETS_DEVICE_INTEGRITY'],locationVerification:'not_verified',keyVerification:'not_evaluated',locationSignals:{mock:false,simulated:null,accessory:null}}});
  if(result.status!=='eligible')throw new Error('Expected eligibility');
  expect(result.assessment.policyDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(result.assessment.configurationDigest).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(result)).not.toMatch(/synthetic-play-token|synthetic-server-token|latitude|accepted|trustTier/);
  expect(f.transport).toHaveBeenCalledOnce();
 });
 it('has no policy defaults and refuses malformed/extra configuration before acquiring credentials',async()=>{
  const f=fixture();
  for(const policy of [undefined,{}, {...f.policy,licensing:'optional'}, {...f.policy,maxTokenAgeMs:0},
   {...f.policy,maxTokenAgeMs:120001},{...f.policy,allowedFutureSkewMs:30001},{...f.policy,allowMissingPlay:true},
   {...f.policy,locationSignals:{...f.policy.locationSignals,mock:'allow'}}]){
   expect(await createAndroidClockIntegrityVerifier(f.settings,policy,f.accessToken,f.options)('token',f.request)).toEqual({status:'unavailable',reason:'configuration_unavailable'});
  }
  expect(await createAndroidClockIntegrityVerifier({...f.settings,apiOrigin:'http://unsafe.test'},f.policy,f.accessToken,f.options)('token',f.request)).toEqual({status:'unavailable',reason:'configuration_unavailable'});
  expect(await createAndroidClockIntegrityVerifier(f.settings,f.policy,null,f.options)('token',f.request)).toEqual({status:'unavailable',reason:'configuration_unavailable'});
  expect(f.accessToken).not.toHaveBeenCalled();expect(f.transport).not.toHaveBeenCalled();
 });
 it('does not trust a decoded verdict supplied in place of a token or a non-Android command',async()=>{
  const f=fixture();
  expect(await f.verify(f.payload(),f.request)).toEqual({status:'refused',reason:'invalid_proof'});
  expect(await f.verify('token',{...f.request,clientData:{...f.command,evidence:{...f.command.evidence,platform:'ios'}}})).toEqual({status:'refused',reason:'invalid_proof'});
  expect(f.transport).not.toHaveBeenCalled();
 });
 it('requires Google to bind the actual request, app, signer and build before policy eligibility',async()=>{
  const f=fixture();
  const wrongHash=f.payload();wrongHash.tokenPayloadExternal.requestDetails.requestHash='B'.repeat(43);
  const wrongPackage=f.payload();wrongPackage.tokenPayloadExternal.appIntegrity.packageName='other.app';
  const wrongSigner=f.payload();wrongSigner.tokenPayloadExternal.appIntegrity.certificateSha256Digest=[Buffer.alloc(32,2).toString('base64')];
  const wrongBuild=f.payload();wrongBuild.tokenPayloadExternal.appIntegrity.versionCode='5';
  for(const payload of [wrongHash,wrongPackage,wrongSigner,wrongBuild]){
   f.transport.mockResolvedValueOnce(Response.json(payload));expect(await f.verify('token',f.request)).toEqual({status:'refused',reason:'invalid_proof'});
  }
 });
 it('refuses unrecognized apps despite a valid request hash and device label',async()=>{
  const f=fixture(),value=f.payload();value.tokenPayloadExternal.appIntegrity.appRecognitionVerdict='UNRECOGNIZED_VERSION';
  f.transport.mockResolvedValueOnce(Response.json(value));expect(await f.verify('token',f.request)).toEqual({status:'refused',reason:'unrecognized_app'});
 });
 it('requires device integrity, treating basic/virtual/empty labels as insufficient',async()=>{
  const f=fixture();for(const labels of [[],['MEETS_BASIC_INTEGRITY'],['MEETS_VIRTUAL_INTEGRITY'],['MEETS_STRONG_INTEGRITY']]){
   const value=f.payload();value.tokenPayloadExternal.deviceIntegrity.deviceRecognitionVerdict=labels;f.transport.mockResolvedValueOnce(Response.json(value));
   expect(await f.verify('token',f.request)).toEqual({status:'refused',reason:'device_integrity'});
  }
 });
 it('requires an explicitly selected strong tier and never silently downgrades it',async()=>{
  const f=fixture(),verify=createAndroidClockIntegrityVerifier(f.settings,{...f.policy,minimumDeviceIntegrity:'strong'},f.accessToken,f.options);
  expect(await verify('token',f.request)).toEqual({status:'refused',reason:'device_integrity'});
  const value=f.payload();value.tokenPayloadExternal.deviceIntegrity.deviceRecognitionVerdict.push('MEETS_STRONG_INTEGRITY');f.transport.mockResolvedValueOnce(Response.json(value));
  expect(await verify('another-token',f.request)).toMatchObject({status:'eligible'});
 });
 it('keeps unknown vendor labels unavailable even beside an otherwise acceptable label',async()=>{
  const f=fixture(),value=f.payload();value.tokenPayloadExternal.deviceIntegrity.deviceRecognitionVerdict.push('FUTURE_DEVICE_LABEL');f.transport.mockResolvedValueOnce(Response.json(value));
  expect(await f.verify('token',f.request)).toEqual({status:'unavailable',reason:'unknown_vendor_verdict'});
 });
 it('distinguishes licensing refusal, unavailable evaluation and explicitly permitted unlicensed distribution',async()=>{
  const f=fixture(),unlicensed=f.payload();unlicensed.tokenPayloadExternal.accountDetails.appLicensingVerdict='UNLICENSED';
  f.transport.mockResolvedValueOnce(Response.json(unlicensed));expect(await f.verify('token',f.request)).toEqual({status:'refused',reason:'unlicensed_app'});
  const any=createAndroidClockIntegrityVerifier(f.settings,{...f.policy,licensing:'any_evaluated'},f.accessToken,f.options);
  f.transport.mockResolvedValueOnce(Response.json(unlicensed));expect(await any('token',f.request)).toMatchObject({status:'eligible',assessment:{licensing:'UNLICENSED'}});
  const unavailable=f.payload();unavailable.tokenPayloadExternal.accountDetails.appLicensingVerdict='UNEVALUATED';
  for(const verify of [f.verify,any]){f.transport.mockResolvedValueOnce(Response.json(unavailable));expect(await verify('token',f.request)).toEqual({status:'unavailable',reason:'licensing_unavailable'});}
 });
 it.each([['mock','reported_mock'],['simulated','reported_simulation'],['accessory','reported_accessory']] as const)('refuses a reported %s flag under its selected rule',async(field,reason)=>{
  const f=fixture();f.command.evidence[field]=true;
  const verify=createAndroidClockIntegrityVerifier(f.settings,{...f.policy,locationSignals:{...f.policy.locationSignals,[field]:'deny_reported'}},f.accessToken,f.options);
  expect(await verify('token',f.request)).toEqual({status:'refused',reason});
 });
 it.each(['mock','simulated','accessory'] as const)('preserves unavailable %s evidence instead of manufacturing false',async field=>{
  const f=fixture();f.command.evidence[field]=null;
  const required=createAndroidClockIntegrityVerifier(f.settings,{...f.policy,locationSignals:{...f.policy.locationSignals,[field]:'require_report'}},f.accessToken,f.options);
  expect(await required('token',f.request)).toEqual({status:'unavailable',reason:'location_signal_unavailable'});
  const reported=createAndroidClockIntegrityVerifier(f.settings,{...f.policy,locationSignals:{...f.policy.locationSignals,[field]:'deny_reported'}},f.accessToken,f.options);
  const result=await reported('another-token',f.request);expect(result).toMatchObject({status:'eligible',assessment:{locationSignals:{[field]:null},locationVerification:'not_verified'}});
 });
 it('retains an explicitly allowed accessory signal without turning it into location verification',async()=>{
  const f=fixture();f.command.evidence.accessory=true;
  expect(await f.verify('token',f.request)).toMatchObject({status:'eligible',assessment:{locationSignals:{accessory:true},locationVerification:'not_verified'}});
 });
 it('enforces configured token-age/future limits and the exclusive challenge deadline after decoding',async()=>{
  const f=fixture();f.request.challengeIssuedAt=f.now-2000;
  for(const timestamp of [f.now-1001,f.now+1]){
   const value=f.payload();value.tokenPayloadExternal.requestDetails.timestampMillis=String(timestamp);f.transport.mockResolvedValueOnce(Response.json(value));
   expect(await f.verify('token',f.request)).toEqual({status:'refused',reason:'stale_token'});
  }
  const value=f.payload();value.tokenPayloadExternal.requestDetails.timestampMillis=String(f.now+1);f.transport.mockResolvedValueOnce(Response.json(value));
  expect(await createAndroidClockIntegrityVerifier(f.settings,{...f.policy,allowedFutureSkewMs:1},f.accessToken,f.options)('token',f.request)).toMatchObject({status:'eligible'});
  f.transport.mockImplementationOnce(async()=>{f.setTime(f.command.challenge.expiresAt);return Response.json(f.payload());});
  expect(await f.verify('token',f.request)).toEqual({status:'refused',reason:'challenge_unavailable'});
 });
 it('accepts exact policy age/skew bounds, and refuses nonfinite/throwing server clocks privately',async()=>{
  const f=fixture();f.request.challengeIssuedAt=f.now-2000;
  const value=f.payload();value.tokenPayloadExternal.requestDetails.timestampMillis=String(f.now-1000);f.transport.mockResolvedValueOnce(Response.json(value));
  expect(await f.verify('token',f.request)).toMatchObject({status:'eligible'});
  const nan=createAndroidClockIntegrityVerifier(f.settings,f.policy,f.accessToken,{...f.options,now:()=>NaN});
  expect(await nan('token',f.request)).toEqual({status:'unavailable',reason:'time_unavailable'});
  let calls=0;const failure=createAndroidClockIntegrityVerifier(f.settings,f.policy,f.accessToken,{...f.options,now:()=>{if(++calls===2)throw new Error('SYNTHETIC_PRIVATE_CLOCK_FAILURE');return f.now;}});
  expect(await failure('token',f.request)).toEqual({status:'unavailable',reason:'provider_unavailable'});
  expect(f.transport).toHaveBeenCalledOnce();
 });
 it('does not downgrade provider failure, replay-cleared responses, abort or a backwards clock to eligibility',async()=>{
  const f=fixture();for(const response of [new Response('SYNTHETIC_PRIVATE_ERROR',{status:503}),Response.json({tokenPayloadExternal:{...f.payload().tokenPayloadExternal,appIntegrity:{appRecognitionVerdict:'UNEVALUATED'}}})]){
   f.transport.mockResolvedValueOnce(response);expect(await f.verify('token',f.request)).toEqual({status:'unavailable',reason:'provider_unavailable'});
  }
  const signal=new AbortController();signal.abort();expect(await f.verify('token',f.request,signal.signal)).toEqual({status:'unavailable',reason:'provider_unavailable'});
  f.transport.mockImplementationOnce(async()=>{f.setTime(f.now-1);return Response.json(f.payload());});
  expect((await f.verify('token',f.request)).status).toBe('unavailable');expect(f.transport).toHaveBeenCalledTimes(3);
 });
 it('snapshots target, requirements and the exact context before awaiting Google',async()=>{
  const f=fixture(),value=f.payload(),hash=onlineClockClientDataHash(f.command).toString('hex');let release!:(response:Response)=>void;
  f.transport.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
  const pending=f.verify('token',f.request);await vi.waitFor(()=>expect(f.transport).toHaveBeenCalledOnce());
  f.command.command.lat=9;f.command.evidence.mock=true;f.policy.minimumDeviceIntegrity='strong';f.settings.target.certificateDigests[0]=Buffer.alloc(32,2).toString('base64');
  release(Response.json(value));const result=await pending;
  expect(result).toMatchObject({status:'eligible',assessment:{clientDataHash:hash,locationSignals:{mock:false}}});
 });
 it('changes the policy digest when a requirement changes, independent of input property order',async()=>{
  const f=fixture(),first=await f.verify('token',f.request),changed=await createAndroidClockIntegrityVerifier(f.settings,{...f.policy,maxTokenAgeMs:2000},f.accessToken,f.options)('token',f.request);
  const reordered=await createAndroidClockIntegrityVerifier(f.settings,Object.fromEntries(Object.entries(f.policy).reverse()),f.accessToken,f.options)('token',f.request);
  if(first.status!=='eligible'||changed.status!=='eligible'||reordered.status!=='eligible')throw new Error('Expected eligibility');
  expect(first.assessment.policyDigest).not.toBe(changed.assessment.policyDigest);expect(first.assessment.policyDigest).toBe(reordered.assessment.policyDigest);
 });
 it('binds the actual deployment target and origin independently of the requirements digest',async()=>{
  const f=fixture(),first=await f.verify('token',f.request);
  const second=await createAndroidClockIntegrityVerifier({...f.settings,target:{...f.settings.target,versionCodes:['4','5']}},f.policy,f.accessToken,f.options)('token',f.request);
  if(first.status!=='eligible'||second.status!=='eligible')throw new Error('Expected eligibility');
  expect(first.assessment.configurationDigest).not.toBe(second.assessment.configurationDigest);
  expect(first.assessment.policyDigest).toBe(second.assessment.policyDigest);
 });
});
