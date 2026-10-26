/** Transport ports are synthetic. These tests do not contact Google or establish device evidence. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createPlayIntegrityVerifier} from '../lib/mobile-api/play-integrity';
import {onlineClockClientDataHash} from '../lib/mobile-api/clock-integrity';
const now=1800000000000,pkg='ai.stradaverse.aihr.test',certificate='A'.repeat(43);
const id=(n:number)=>`${String(n).padStart(8,'0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
function clientData(){return {version:1,purpose:'attendance.clock.online',
  scope:{apiOrigin:'https://hr.example.com',installationId:id(1),tenantId:id(2),actorId:id(3),employmentId:id(4),deviceKeyId:id(5)},
  challenge:{id:id(6),nonce:'A'.repeat(43),expiresAt:now+60000},
  command:{requestId:id(7),action:'in',lat:3.1,lng:101.1,accuracy:10,sampledAt:now,photo:null},
  evidence:{platform:'android',appId:pkg,appVersion:'1.0.3',buildVersion:'4',provider:null,mock:null,simulated:null,accessory:null},
};}
function fixture(){
  const command=clientData(),request={clientData:command,challengeIssuedAt:now-1000};
  const config={packageName:pkg,certificateDigests:[certificate],versionCodes:['4']};
  const payload=()=>({tokenPayloadExternal:{requestDetails:{requestPackageName:pkg,requestHash:onlineClockClientDataHash(command).toString('base64url'),timestampMillis:String(now)},
    appIntegrity:{appRecognitionVerdict:'PLAY_RECOGNIZED',packageName:pkg,certificateSha256Digest:[certificate],versionCode:'4'},
    accountDetails:{appLicensingVerdict:'LICENSED'},deviceIntegrity:{deviceRecognitionVerdict:['MEETS_DEVICE_INTEGRITY']}}});
  const transport=vi.fn<typeof fetch>(async()=>Response.json(payload()));
  const accessToken=vi.fn(async()=> 'synthetic-access-token');
  const verify=createPlayIntegrityVerifier(config,accessToken,{transport,now:()=>now});
  return {command,request,config,payload,transport,accessToken,verify};
}
afterEach(()=>vi.useRealTimers());
describe('bounded Google Play standard-token verification boundary',()=>{
  it('calls only the fixed Google decode endpoint with scoped bearer auth and binds its verified response',async()=>{
    const f=fixture(),result=await f.verify('synthetic-integrity-token',f.request);
    expect(result).toEqual({status:'evidence',vendorVerification:'google_api',evidence:{appRecognition:'PLAY_RECOGNIZED',licensing:'LICENSED',deviceLabels:['MEETS_DEVICE_INTEGRITY'],unknownDeviceLabels:false,requestedAt:now}});
    expect(f.accessToken).toHaveBeenCalledExactlyOnceWith('https://www.googleapis.com/auth/playintegrity',expect.any(AbortSignal));
    expect(f.transport).toHaveBeenCalledExactlyOnceWith(`https://playintegrity.googleapis.com/v1/${pkg}:decodeIntegrityToken`,expect.objectContaining({
      method:'POST',redirect:'error',cache:'no-store',headers:expect.objectContaining({authorization:'Bearer synthetic-access-token'}),body:JSON.stringify({integrityToken:'synthetic-integrity-token'})}));
  });
  it('does not contact a provider for missing configuration, bad token, wrong platform or unsupported build',async()=>{
    const f=fixture();
    expect(await createPlayIntegrityVerifier(f.config,null,{transport:f.transport})('token',f.request)).toMatchObject({status:'unavailable',reason:'not_configured'});
    for(const token of ['', 'a\n','a'.repeat(32769)])expect(await f.verify(token,f.request)).toMatchObject({status:'invalid',reason:'invalid_input'});
    expect(await f.verify('token',{...f.request,clientData:{...f.command,evidence:{...f.command.evidence,platform:'ios'}}})).toMatchObject({status:'invalid'});
    expect(await f.verify('token',{...f.request,clientData:{...f.command,evidence:{...f.command.evidence,buildVersion:'5'}}})).toMatchObject({status:'invalid'});
    expect(f.accessToken).not.toHaveBeenCalled();expect(f.transport).not.toHaveBeenCalled();
  });
  it('rejects package/hash substitution and timestamps before issuance or outside the bounded future window',async()=>{
    const f=fixture();
    for(const change of [{requestPackageName:'other.app'},{requestHash:'B'.repeat(43)},{timestampMillis:String(now-1001)},{timestampMillis:String(now+30001)}]){
      const value=f.payload();Object.assign(value.tokenPayloadExternal.requestDetails,change);f.transport.mockResolvedValueOnce(Response.json(value));
      expect(await f.verify('token',f.request)).toMatchObject({status:'invalid'});
    }
  });
  it('checks every signer and the actual package/version, with canonical padded digest support',async()=>{
    const f=fixture();
    for(const change of [{packageName:'other.app'},{versionCode:'5'},{certificateSha256Digest:[]},{certificateSha256Digest:[certificate,'B'+'A'.repeat(42)]}]){
      const value=f.payload();Object.assign(value.tokenPayloadExternal.appIntegrity,change);f.transport.mockResolvedValueOnce(Response.json(value));
      expect(await f.verify('token',f.request)).toMatchObject({status:'invalid',reason:'app_mismatch'});
    }
    const padded=f.payload();padded.tokenPayloadExternal.appIntegrity.certificateSha256Digest=[certificate+'='];f.transport.mockResolvedValueOnce(Response.json(padded));
    expect(await f.verify('token',f.request)).toMatchObject({status:'evidence'});
  });
  it('keeps unevaluated/replay-cleared responses unavailable and lower signals as evidence without assigning trust',async()=>{
    const f=fixture();
    f.transport.mockResolvedValueOnce(Response.json({tokenPayloadExternal:{...f.payload().tokenPayloadExternal,
      appIntegrity:{appRecognitionVerdict:'UNEVALUATED'},accountDetails:{appLicensingVerdict:'UNEVALUATED'},deviceIntegrity:{}}}));
    expect(await f.verify('token',f.request)).toEqual({status:'unavailable',reason:'not_evaluated'});
    const value=f.payload();value.tokenPayloadExternal.appIntegrity.appRecognitionVerdict='UNRECOGNIZED_VERSION';value.tokenPayloadExternal.accountDetails.appLicensingVerdict='UNLICENSED';
    value.tokenPayloadExternal.deviceIntegrity.deviceRecognitionVerdict=['MEETS_BASIC_INTEGRITY','FUTURE_VENDOR_LABEL'];f.transport.mockResolvedValueOnce(Response.json(value));
    const result=await f.verify('different-token',f.request);
    expect(result).toMatchObject({status:'evidence',evidence:{appRecognition:'UNRECOGNIZED_VERSION',licensing:'UNLICENSED',deviceLabels:['MEETS_BASIC_INTEGRITY'],unknownDeviceLabels:true}});
    expect(result).not.toHaveProperty('trustTier');expect(result).not.toHaveProperty('accepted');
  });
  it('retains named refusals for invalid tokens, credentials, quotas and outages without retrying or exposing bodies',async()=>{
    const f=fixture();
    for(const [status,reason] of [[400,'invalid_token'],[401,'provider_configuration'],[403,'provider_configuration'],[429,'rate_limited'],[503,'provider_unavailable']] as const){
      f.transport.mockResolvedValueOnce(new Response('SYNTHETIC_PRIVATE_PROVIDER_ERROR',{status}));
      const result=await f.verify('token',f.request);expect(result).toMatchObject({reason});expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE');
    }
    expect(f.transport).toHaveBeenCalledTimes(5);
  });
  it('bounds malformed/oversized responses and credential-provider failures',async()=>{
    const f=fixture();
    for(const response of [Response.json({}),new Response('{invalid'),new Response('x'.repeat(65537))]){
      f.transport.mockResolvedValueOnce(response);expect(await f.verify('token',f.request)).toMatchObject({status:'unavailable',reason:'malformed_response'});
    }
    f.accessToken.mockRejectedValueOnce(new Error('SYNTHETIC_PRIVATE_CREDENTIAL_ERROR'));
    expect(await f.verify('token',f.request)).toEqual({status:'unavailable',reason:'provider_unavailable'});
    f.accessToken.mockResolvedValueOnce('unsafe\ncredential');
    expect(await f.verify('token',f.request)).toEqual({status:'unavailable',reason:'provider_configuration'});
  });
  it('covers response-body time in the deadline and aborts the owned request',async()=>{
    vi.useFakeTimers();const f=fixture(),cancel=vi.fn();
    f.transport.mockResolvedValueOnce(new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{'));},cancel})));
    const pending=f.verify('token',f.request);await vi.advanceTimersByTimeAsync(10001);
    expect(await pending).toEqual({status:'unavailable',reason:'timeout'});expect(cancel).toHaveBeenCalled();
    const options=f.transport.mock.calls[0][1];expect(options?.signal?.aborted).toBe(true);
  });
  it('does not start a late decode after credential acquisition times out, or after caller cancellation',async()=>{
    vi.useFakeTimers();const f=fixture();let release!:(value:string)=>void;
    f.accessToken.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const pending=f.verify('token',f.request);await vi.advanceTimersByTimeAsync(10001);
    expect(await pending).toEqual({status:'unavailable',reason:'timeout'});release('late-credential');await Promise.resolve();expect(f.transport).not.toHaveBeenCalled();
    const controller=new AbortController();controller.abort();expect(await f.verify('token',f.request,controller.signal)).toEqual({status:'unavailable',reason:'aborted'});
    expect(f.transport).not.toHaveBeenCalled();
  });
  it('rechecks expiry after decoding and refuses malformed configuration before any network work',async()=>{
    const f=fixture();let time=now;
    const verify=createPlayIntegrityVerifier(f.config,f.accessToken,{transport:f.transport,now:()=>time});
    f.transport.mockImplementationOnce(async()=>{time=now+60001;return Response.json(f.payload());});
    expect(await verify('token',f.request)).toMatchObject({status:'invalid',reason:'expired_challenge'});
    const bad=createPlayIntegrityVerifier({...f.config,packageName:pkg+'\n'},f.accessToken,{transport:f.transport});
    expect(await bad('token',f.request)).toMatchObject({status:'unavailable',reason:'not_configured'});
    expect(f.transport).toHaveBeenCalledOnce();
  });
  it('refuses malformed version/digest configuration without throwing or reading credentials',async()=>{
    const f=fixture();
    for(const change of [{versionCodes:['not-an-integer']},{versionCodes:['9223372036854775808']},{versionCodes:['1\n']},
      {certificateDigests:[certificate+'\n']},{certificateDigests:['short']}]){
      const verify=createPlayIntegrityVerifier({...f.config,...change},f.accessToken,{transport:f.transport});
      expect(await verify('token',f.request)).toEqual({status:'unavailable',reason:'not_configured'});
    }
    expect(f.accessToken).not.toHaveBeenCalled();expect(f.transport).not.toHaveBeenCalled();
  });
});
