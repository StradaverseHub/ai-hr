/** Shipped JS boundary with native ports. This does not verify vendor certificates or hardware. */
import {afterEach,describe,expect,it,vi} from 'vitest';
import {createIntegrityBridge} from '../mobile/lib/integrity-bridge';
import {SessionChangedError} from '../mobile/lib/errors';
const alias='aihr_'+'a'.repeat(64),hash=Buffer.alloc(32).toString('base64'),requestHash=Buffer.alloc(32).toString('base64url');
function fixture(){
  let current=true;
  const native={
    capabilities:vi.fn(()=>({version:1,platform:'ios',appId:'ai.stradaverse.aihr.test',appVersion:'1.0.3',buildVersion:'4',keyMechanism:'apple_app_attest'})),
    clockSnapshot:vi.fn(()=>({localOnly:true as const,runtimeId:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',source:'ios_continuous',elapsedBeforeNs:'9007199254740993',elapsedAfterNs:'9007199254740995',wallTimeMs:Date.now(),bootId:null})),
    appleKeyInfo:vi.fn<(...args:unknown[])=>Promise<unknown>>(async()=>null),generateAppleKey:vi.fn<(...args:unknown[])=>Promise<unknown>>(async()=>'opaque-key-reference'),
    appleAttestationInfo:vi.fn<(...args:unknown[])=>Promise<unknown>>(async()=>({state:'absent'})),
    releaseAppleAttestation:vi.fn<(...args:unknown[])=>Promise<unknown>>(async()=>null),resetAppleIntegrityInstallation:vi.fn<(...args:unknown[])=>Promise<unknown>>(async()=>null),
    attestAppleKey:vi.fn<(...args:unknown[])=>Promise<unknown>>(async()=>Buffer.from('unverified platform artifact').toString('base64')),
    assertAppleKey:vi.fn<(...args:unknown[])=>Promise<unknown>>(async()=>Buffer.from('unverified assertion').toString('base64')),
    createAndroidKey:vi.fn<(...args:unknown[])=>Promise<unknown>>(async()=>({publicKeySpki:Buffer.from('unverified public key').toString('base64'),certificateChain:[Buffer.from('not a certificate').toString('base64')],reportedSecurityLevel:'software'})),
    androidKeyInfo:vi.fn<(...args:unknown[])=>Promise<unknown>>(async()=>({})),signAndroidCommand:vi.fn<(...args:unknown[])=>Promise<unknown>>(async()=>'c2ln'),
    preparePlayIntegrity:vi.fn<(...args:unknown[])=>Promise<unknown>>(async()=>null),requestPlayIntegrity:vi.fn<(...args:unknown[])=>Promise<unknown>>(async()=>'unverified-token'),
  };
  const check=()=>{if(!current)throw new SessionChangedError();};
  return {native,bridge:createIntegrityBridge(native,check),changeAccount:()=>{current=false;}};
}
afterEach(()=>vi.useRealTimers());
describe('native integrity evidence boundary',()=>{
  it('recovers native proof state without retrying a one-use vendor operation or claiming verification',async()=>{
    const f=fixture(),attestation=Buffer.from('retained artifact').toString('base64');
    for(const state of [{state:'absent'},{state:'requested'},{state:'retryable'},{state:'completed',attestation},{state:'released'}]){
      f.native.appleAttestationInfo.mockResolvedValueOnce(state);
      expect(await f.bridge.appleAttestationInfo('same-key',hash)).toEqual({status:'evidence',evidence:state,verification:'not_verified'});
    }
    expect(f.native.attestAppleKey).not.toHaveBeenCalled();expect(f.native.generateAppleKey).not.toHaveBeenCalled();
    expect(f.native.appleAttestationInfo.mock.calls).toEqual(Array(5).fill(['same-key',hash]));
  });
  it('rejects malformed proof-cache records and noncanonical or oversized cached artifacts',async()=>{
    const f=fixture();
    for(const value of [{state:'verified'},{state:'completed',attestation:''},{state:'completed',attestation:'AB=='},
      {state:'completed',attestation:Buffer.alloc(65537).toString('base64')},{state:'retryable',attestation:'AAAA'},
      {state:'completed',attestation:'AAAA',verified:true}]){
      f.native.appleAttestationInfo.mockResolvedValueOnce(value);
      expect(await f.bridge.appleAttestationInfo('same-key',hash)).toEqual({status:'unavailable',reason:'malformed'});
    }
    expect(await f.bridge.appleAttestationInfo('key',hash+'\n')).toEqual({status:'invalid',reason:'invalid_input'});
    expect(f.native.appleAttestationInfo).toHaveBeenCalledTimes(6);
  });
  it('keeps hash conflicts and uncertain one-use calls distinct without fallback or key replacement',async()=>{
    const f=fixture();f.native.attestAppleKey.mockRejectedValueOnce({code:'ERR_INTEGRITY_BINDING_CONFLICT',message:'private'});
    expect(await f.bridge.attestAppleKey('same-key',hash)).toEqual({status:'invalid',reason:'binding_conflict'});
    f.native.attestAppleKey.mockRejectedValueOnce({code:'ERR_INTEGRITY_RECOVERY_REQUIRED',message:'private'});
    expect(await f.bridge.attestAppleKey('same-key',hash)).toEqual({status:'unavailable',reason:'recovery_required'});
    expect(f.native.generateAppleKey).not.toHaveBeenCalled();expect(f.native.appleAttestationInfo).not.toHaveBeenCalled();
    const old={...f.native,appleAttestationInfo:undefined} as unknown as Parameters<typeof createIntegrityBridge>[0];
    expect(await createIntegrityBridge(old,()=>{}).appleAttestationInfo('same-key',hash)).toEqual({status:'unsupported',reason:'method_missing'});
  });
  it('rejects a recovered artifact delivered after its authenticated owner changed',async()=>{
    const f=fixture();let complete!:(value:unknown)=>void;
    f.native.appleAttestationInfo.mockImplementationOnce(()=>new Promise(resolve=>{complete=resolve;}));
    const pending=f.bridge.appleAttestationInfo('same-key',hash);await Promise.resolve();f.changeAccount();complete({state:'completed',attestation:'AAAA'});
    await expect(pending).rejects.toBeInstanceOf(SessionChangedError);
  });
  it('keeps absent bridges unsupported instead of substituting a JavaScript signing key',async()=>{
    const bridge=createIntegrityBridge(null,()=>{});
    expect(bridge.capabilities()).toEqual({status:'unsupported',reason:'bridge_missing'});
    expect(await bridge.generateAppleKey(alias)).toEqual({status:'unsupported',reason:'bridge_missing'});
  });
  it('preserves exact monotonic integers without calling them verified time',()=>{
    const f=fixture(),snapshot=f.bridge.clockSnapshot();
    expect(snapshot).toMatchObject({status:'evidence',verification:'not_verified',evidence:{elapsedBeforeNs:'9007199254740993',bootId:null}});
    f.native.clockSnapshot.mockReturnValueOnce({...f.native.clockSnapshot(),elapsedBeforeNs:'private malformed value'});
    expect(f.bridge.clockSnapshot()).toEqual({status:'unavailable',reason:'malformed'});
    f.native.clockSnapshot.mockReturnValueOnce({...f.native.clockSnapshot(),elapsedAfterNs:'1'});
    expect(f.bridge.clockSnapshot().status).toBe('unavailable');
  });
  it('refuses incompatible capabilities and forged trust fields',()=>{
    const f=fixture();f.native.capabilities.mockReturnValueOnce({...f.native.capabilities(),platform:'android'});
    expect(f.bridge.capabilities().status).toBe('unavailable');
    f.native.capabilities.mockImplementationOnce(()=>({...f.native.capabilities.getMockImplementation()!(),verified:true}));
    expect(f.bridge.capabilities().status).toBe('unavailable');
  });
  it('rejects invalid aliases, hashes, project numbers and noncanonical base64 before native calls',async()=>{
    const f=fixture();
    for(const value of ['../other',alias+'\n'])expect(await f.bridge.generateAppleKey(value)).toEqual({status:'invalid',reason:'invalid_input'});
    expect(await f.bridge.attestAppleKey('key',hash+'\n')).toMatchObject({status:'invalid'});
    expect(await f.bridge.createAndroidKey(alias,'bad-hash')).toMatchObject({status:'invalid'});
    for(const project of ['not-a-number','1\n','9223372036854775808'])expect(await f.bridge.preparePlayIntegrity(project)).toMatchObject({status:'invalid'});
    expect(await f.bridge.signAndroidCommand(alias,'AAB=')).toMatchObject({status:'invalid'});
    expect(f.native.generateAppleKey).not.toHaveBeenCalled();expect(f.native.attestAppleKey).not.toHaveBeenCalled();expect(f.native.preparePlayIntegrity).not.toHaveBeenCalled();
  });
  it('keeps Apple service outages separate and never regenerates or changes the enrollment inputs',async()=>{
    const f=fixture();f.native.attestAppleKey.mockRejectedValue({code:'ERR_INTEGRITY_SERVER_UNAVAILABLE',message:'SYNTHETIC_PRIVATE_VALUE'});
    for(let i=0;i<2;i++)expect(await f.bridge.attestAppleKey('same-key',hash)).toEqual({status:'unavailable',reason:'server_unavailable'});
    expect(f.native.attestAppleKey.mock.calls).toEqual([['same-key',hash],['same-key',hash]]);expect(f.native.generateAppleKey).not.toHaveBeenCalled();
  });
  it('does not treat a native certificate chain or hardware hint as verified attestation',async()=>{
    const f=fixture(),result=await f.bridge.createAndroidKey(alias,hash);
    expect(result).toMatchObject({status:'evidence',verification:'not_verified',evidence:{reportedSecurityLevel:'software'}});
    expect(result).not.toHaveProperty('verified');
  });
  it('does not fall back from an unavailable hardware option or replace an existing key',async()=>{
    const f=fixture();f.native.createAndroidKey.mockRejectedValueOnce({code:'ERR_INTEGRITY_UNSUPPORTED'});
    expect(await f.bridge.createAndroidKey(alias,hash,true)).toEqual({status:'unsupported',reason:'unsupported'});
    expect(f.native.createAndroidKey).toHaveBeenCalledExactlyOnceWith(alias,hash,true);
    f.native.createAndroidKey.mockRejectedValueOnce({code:'ERR_INTEGRITY_KEY_EXISTS'});
    expect(await f.bridge.createAndroidKey(alias,hash)).toEqual({status:'invalid',reason:'key_exists'});expect(f.native.androidKeyInfo).not.toHaveBeenCalled();
  });
  it('bounds a stalled operation without automatic retry and ignores its late result',async()=>{
    vi.useFakeTimers();const f=fixture();let release!:(value:unknown)=>void;
    f.native.generateAppleKey.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const pending=f.bridge.generateAppleKey(alias);await vi.advanceTimersByTimeAsync(20001);
    expect(await pending).toEqual({status:'unavailable',reason:'timeout'});release('late-key-reference');await Promise.resolve();
    await vi.advanceTimersByTimeAsync(60000);expect(f.native.generateAppleKey).toHaveBeenCalledOnce();
  });
  it('rejects an obsolete actor on late success or failure rather than granting a lower-tier outcome',async()=>{
    const f=fixture();let release!:(value:unknown)=>void;
    f.native.generateAppleKey.mockImplementationOnce(()=>new Promise(resolve=>{release=resolve;}));
    const pending=f.bridge.generateAppleKey(alias);await Promise.resolve();f.changeAccount();release('old-key');
    await expect(pending).rejects.toBeInstanceOf(SessionChangedError);
  });
  it('keeps an expired Play provider unavailable without silently preparing another',async()=>{
    const f=fixture();f.native.requestPlayIntegrity.mockRejectedValueOnce({code:'ERR_INTEGRITY_PROVIDER_EXPIRED',message:'SYNTHETIC_PRIVATE_VALUE'});
    const result=await f.bridge.requestPlayIntegrity(requestHash);
    expect(result).toEqual({status:'unavailable',reason:'provider_expired'});expect(JSON.stringify(result)).not.toContain('SYNTHETIC_PRIVATE_VALUE');
    expect(f.native.preparePlayIntegrity).not.toHaveBeenCalled();
  });
});
