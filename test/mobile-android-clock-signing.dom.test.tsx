/** Shipped adapter + bridge, synthetic signing port, real server cryptography. No Android hardware. */
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {ModuleKind,transpileModule} from 'typescript';
import {generateKeyPairSync,sign} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import * as canonical from '../lib/mobile-clock-integrity';
import {createIntegrityBridge} from '../mobile/lib/integrity-bridge';
import {SessionChangedError,UnavailableError} from '../mobile/lib/errors';
import {checkAndroidClockSignature} from '../lib/mobile-api/android-clock-signature';
import vector from './fixtures/mobile-integrity/android-jca-clock-signature.json';
const alias='aihr_'+'a'.repeat(64);
function fixture(){
 let current=true,foreground=true;
 const assertCurrent=()=>{if(!current)throw new SessionChangedError();};
 const {publicKey,privateKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
 const native={capabilities:vi.fn(()=>({version:1,platform:'android',keyMechanism:'android_keystore',appId:vector.clientData.evidence.appId,appVersion:'1.0',buildVersion:'4'})),
  signAndroidCommand:vi.fn(async(_alias:string,encoded:string)=>sign('sha256',Buffer.from(encoded,'base64'),privateKey).toString('base64'))};
 const bridge=createIntegrityBridge(native as never,assertCurrent,30);
 const output={exports:{} as {createAndroidClockSigner:typeof import('../mobile/lib/android-clock-signing').createAndroidClockSigner}};
 runInNewContext(transpileModule(readFileSync('mobile/lib/android-clock-signing.ts','utf8'),{compilerOptions:{module:ModuleKind.CommonJS}}).outputText,
  {module:output,exports:output.exports,TextEncoder,btoa,require:(name:string)=>{
   if(name==='../../lib/mobile-clock-integrity')return canonical;
   if(name==='./errors')return {UnavailableError};throw new Error(name);
  }});
 return {native,bridge,signer:output.exports.createAndroidClockSigner(bridge,assertCurrent,()=>foreground),publicKey,
  changeOwner:()=>{current=false;},background:()=>{foreground=false;}};
}
afterEach(()=>vi.useRealTimers());
describe('native Android canonical signing adapter',()=>{
 it('passes exact canonical UTF8 bytes to the existing alias and produces a server-verifiable signature',async()=>{
  const f=fixture(),result=await f.signer(alias,vector.clientData);expect(result.status).toBe('evidence');
  const [selected,encoded]=f.native.signAndroidCommand.mock.calls[0];expect(selected).toBe(alias);expect(Buffer.from(encoded,'base64').toString('utf8')).toBe(vector.canonicalUtf8);
  if(result.status!=='evidence')throw new Error('missing evidence');expect(result.verification).toBe('not_verified');
  expect(checkAndroidClockSignature({publicKey:f.publicKey,signature:Buffer.from(result.evidence,'base64'),clientData:vector.clientData,expectedAppId:vector.clientData.evidence.appId,allowedBuildVersions:['4']})).toMatchObject({verification:'command_signature'});
 });
 it('does not hash the message a second time and encodes non-ASCII native versions consistently',async()=>{
  const f=fixture(),clientData=structuredClone(vector.clientData);clientData.evidence.appVersion='版本 1';
  f.native.capabilities.mockReturnValueOnce({...f.native.capabilities(),appVersion:'版本 1'});
  const result=await f.signer(alias,clientData);expect(Buffer.from(f.native.signAndroidCommand.mock.calls[0][1],'base64').toString('utf8')).toBe(canonical.onlineClockClientData(clientData));
  if(result.status!=='evidence')throw new Error('missing evidence');expect(checkAndroidClockSignature({publicKey:f.publicKey,signature:Buffer.from(result.evidence,'base64'),clientData,expectedAppId:clientData.evidence.appId,allowedBuildVersions:['4']})).toMatchObject({verification:'command_signature'});
 });
 it('refuses changed app/build/platform or malformed authority before invoking any signer',async()=>{
  for(const clientData of [{...vector.clientData,evidence:{...vector.clientData.evidence,platform:'ios'}},{...vector.clientData,evidence:{...vector.clientData.evidence,appId:'other.app'}},
    {...vector.clientData,evidence:{...vector.clientData.evidence,buildVersion:'5'}},{...vector.clientData,evidence:{...vector.clientData.evidence,appVersion:'2'}},{...vector.clientData,verified:true}]){
   const f=fixture();expect(await f.signer(alias,clientData)).toEqual({status:'invalid',reason:'invalid_input'});expect(f.native.signAndroidCommand).not.toHaveBeenCalled();
  }
 });
 it('requires the original valid alias and Android native capability without key generation or fallback',async()=>{
  const f=fixture();expect(await f.signer('other-alias',vector.clientData)).toMatchObject({status:'invalid'});expect(f.native.signAndroidCommand).not.toHaveBeenCalled();
  const g=fixture();g.native.capabilities.mockReturnValueOnce({version:1,platform:'ios',keyMechanism:'apple_app_attest',appId:vector.clientData.evidence.appId,appVersion:'1.0',buildVersion:'4'});
  expect(await g.signer(alias,vector.clientData)).toMatchObject({status:'unsupported'});expect(g.native.signAndroidCommand).not.toHaveBeenCalled();
 });
 it('refuses background work before signing and drops late background signatures',async()=>{
  const f=fixture();f.background();await expect(f.signer(alias,vector.clientData)).rejects.toBeInstanceOf(UnavailableError);expect(f.native.signAndroidCommand).not.toHaveBeenCalled();
  const g=fixture();g.native.signAndroidCommand.mockImplementationOnce(async()=>{g.background();return vector.signature;});
  await expect(g.signer(alias,vector.clientData)).rejects.toBeInstanceOf(UnavailableError);
 });
 it('rejects obsolete owners before and after native success or failure',async()=>{
  const f=fixture();f.changeOwner();await expect(f.signer(alias,vector.clientData)).rejects.toBeInstanceOf(SessionChangedError);expect(f.native.signAndroidCommand).not.toHaveBeenCalled();
  for(const fails of [false,true]){
   const g=fixture();g.native.signAndroidCommand.mockImplementationOnce(async()=>{g.changeOwner();if(fails)throw new Error('old native fault');return vector.signature;});
   await expect(g.signer(alias,vector.clientData)).rejects.toBeInstanceOf(SessionChangedError);
  }
 });
 it('preserves unavailable, malformed and timed-out native results without retries',async()=>{
  const f=fixture();f.native.signAndroidCommand.mockRejectedValueOnce({code:'ERR_INTEGRITY_INVALID_KEY'});
  expect(await f.signer(alias,vector.clientData)).toMatchObject({status:'invalid',reason:'invalid_key'});expect(f.native.signAndroidCommand).toHaveBeenCalledOnce();
  f.native.signAndroidCommand.mockResolvedValueOnce('AB==');expect(await f.signer(alias,vector.clientData)).toMatchObject({status:'unavailable',reason:'malformed'});
  vi.useFakeTimers();const g=fixture();g.native.signAndroidCommand.mockReturnValueOnce(new Promise(()=>{}));const pending=g.signer(alias,vector.clientData);await vi.advanceTimersByTimeAsync(31);
  expect(await pending).toMatchObject({status:'unavailable',reason:'timeout'});expect(g.native.signAndroidCommand).toHaveBeenCalledOnce();
 });
});
