/** Execute actual app assembly and durable models. Native SDK/storage/server are synthetic ports;
 * this proves ownership/recovery ordering, not attestation or a mounted server rollout. */
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {ModuleKind,transpileModule} from 'typescript';
import {describe,expect,it,vi} from 'vitest';
import * as C from '../lib/mobile-integrity-contract';
import * as apple from '../mobile/lib/enrollment-journal';
import * as android from '../mobile/lib/android-enrollment-journal';
import {createIntegrityBridge} from '../mobile/lib/integrity-bridge';
import * as errors from '../mobile/lib/errors';
import {enrollmentFixture} from './helpers/mobile-enrollment-fixture';
import {androidEnrollmentFixture} from './helpers/mobile-android-enrollment-fixture';
import {appleReplacementFixture} from './helpers/mobile-apple-replacement-fixture';
type Status=apple.EnrollmentStatus|android.AndroidEnrollmentStatus;
type Device={platform:'ios'|'android';supported:boolean;status():Promise<Status>;begin():Promise<Status>;advance():Promise<Status>;reconcile():Promise<Status>;revoke():Promise<Status>;replace?:()=>Promise<Status>};
function runtime(platform:'ios'|'android',nativeAvailable=true,multiKey=false){
 const a=multiKey?appleReplacementFixture():enrollmentFixture(),d=androidEnrollmentFixture(),f=platform==='ios'?a:d;
 let generation=0,namespace=f.scope.namespace,unlocked=true,nextRequest=f.requestId;
 const appState={currentState:'active'},config={apiUrl:f.scope.apiOrigin};
 const me={actorId:f.scope.actorId,employments:[{employmentId:f.employmentId}]};
 const get=vi.fn(async()=>structuredClone(me)),installation=vi.fn(async()=>f.scope.appInstallationId);
 const post=vi.fn(async(path:string,body:unknown,params:{employmentId:string})=>{
  const id=params.employmentId;
  if(path.endsWith('/begin'))return f.ports.prepare(id,C.IntegrityEnrollmentIntent.parse(body));
  if(path.endsWith('/complete'))return platform==='ios'?a.ports.complete(id,C.IntegrityEnrollmentProof.parse(body)):d.ports.complete(id,C.IntegrityAndroidEnrollmentProof.parse(body));
  if(path.endsWith('/key-receipt'))return f.ports.receipt(id,C.IntegrityKeyLookupIntent.parse(body));
  if(path.endsWith('/revoke'))return f.ports.revoke(id,C.IntegrityRevokeIntent.parse(body));
  throw new Error('Unexpected path');
 });
 const storage={nativeIntegrityInstallationId:installation,
  openNativeEnrollmentJournal:vi.fn(async(scope:apple.EnrollmentScope,check:()=>void,ports:Omit<apple.EnrollmentPorts,'assertCurrent'|'read'|'commit'|'digest'>)=>{
   expect(scope).toEqual(a.scope);return apple.createEnrollmentJournal(scope,{...a.ports,...ports,assertCurrent:check});
  }),
  openNativeAndroidEnrollmentJournal:vi.fn(async(scope:apple.EnrollmentScope,check:()=>void,ports:Omit<android.AndroidEnrollmentPorts,'assertCurrent'|'read'|'commit'|'digest'>)=>{
   expect(scope).toEqual(d.scope);return android.createAndroidEnrollmentJournal(scope,{...d.ports,...ports,assertCurrent:check});
  }),
 };
 const output={exports:{} as {openOwnedDeviceEnrollment:(id:string,unlocked:()=>boolean)=>Promise<Device>}};
 const code=transpileModule(readFileSync('mobile/lib/device-enrollment.ts','utf8'),{compilerOptions:{module:ModuleKind.CommonJS}}).outputText;
 runInNewContext(code,{exports:output.exports,module:output,require:(id:string)=>{
  if(id==='react-native')return {AppState:appState,Platform:{OS:platform}};
  if(id==='expo-crypto')return {randomUUID:()=>nextRequest};
  if(id==='./api')return {apiGet:get,apiPost:post};
  if(id==='./auth')return {authGeneration:()=>generation,assertAuthGeneration:(owner:number)=>{if(owner!==generation)throw new errors.SessionChangedError();}};
  if(id==='./config')return {config,identityNamespace:()=>namespace};
  if(id==='./errors')return errors;
  if(id==='./enrollment-journal')return apple;
  if(id==='./integrity-bridge')return {createIntegrityBridge};
  if(id==='./android-key-enrollment')return {createAndroidKeyEnrollment:()=>d.native};
  if(id==='../modules/aihr-integrity/src/AihrIntegrityModule')return {default:!nativeAvailable?null:platform==='ios'?a.native:{...a.native,capabilities:()=>({version:1,platform:'android',appId:d.context.target.packageName,appVersion:'1.0',buildVersion:'4',keyMechanism:'android_keystore'})}};
  if(id==='./submission-native')return storage;
  if(id==='../../lib/mobile-integrity-contract')return C;
  throw new Error('Unexpected dependency '+id);
 }});
 return {a,d,f,get,post,storage,installation,me,appState,config,
  open:(id=f.employmentId)=>output.exports.openOwnedDeviceEnrollment(id,()=>unlocked),
  lock:()=>{unlocked=false;},unlock:()=>{unlocked=true;},changeActor:()=>{generation++;},changeCompany:()=>{namespace='other-company';},nextRequest:(value:string)=>{nextRequest=value;}};
}
it('connects explicit iPhone replacement to the original scoped journal and fresh receipt reader',async()=>{
 const r=runtime('ios',true,true),device=await r.open();await device.begin();await device.advance();await device.revoke();
 r.nextRequest('99999999-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
 expect(await device.replace!()).toMatchObject({status:'pending',phase:'requested'});expect(r.a.native.generateAppleKey).toHaveBeenCalledOnce();
 expect(await device.advance()).toMatchObject({status:'stored_key',revoked:false});expect(r.a.native.generateAppleKey).toHaveBeenCalledTimes(2);
 const saved=r.f.stored();expect(saved?.version).toBe(3);if(saved?.version!==3)throw new Error('missing retirement');expect(saved.retired).toHaveLength(1);expect(saved.retired[0].employmentId).toBe(r.f.employmentId);
});
describe.each(['ios','android'] as const)('%s app enrollment assembly',platform=>{
 it('does not create a pending intent when its native module is unsupported',async()=>{
  const r=runtime(platform,false),device=await r.open();expect(device.supported).toBe(false);
  await expect(device.begin()).rejects.toBeInstanceOf(errors.UnavailableError);expect(r.f.stored()).toBeNull();expect(r.post).not.toHaveBeenCalled();
  expect(await device.reconcile()).toEqual({status:'empty'});expect(r.post).not.toHaveBeenCalled();
 });
 it('opens with fresh own identity and stable installation without generating, preparing or posting',async()=>{
  const r=runtime(platform),device=await r.open();expect(device.platform).toBe(platform);expect(await device.status()).toEqual({status:'empty'});
  expect(device.supported).toBe(true);
  expect(r.get).toHaveBeenCalledWith('me');expect(r.installation).toHaveBeenCalledOnce();expect(r.post).not.toHaveBeenCalled();
  expect(r.a.native.generateAppleKey).not.toHaveBeenCalled();expect(r.d.native.create).not.toHaveBeenCalled();
  await device.begin();expect(r.post).not.toHaveBeenCalled();expect(r.f.stored()?.pending).toMatchObject({phase:'requested',requestId:r.f.requestId,employmentId:r.f.employmentId});
  expect(await device.advance()).toMatchObject({status:'stored_key',revoked:false});
  const prefix=platform==='ios'?'integrity/enrollment':'v2/integrity/android/enrollment';
  expect(r.post.mock.calls.map(([path])=>path)).toEqual([prefix+'/begin',platform==='ios'?'integrity/key-receipt':'v2/integrity/key-receipt',prefix+'/complete']);
  expect(r.post.mock.calls.every(([, ,params])=>params.employmentId===r.f.employmentId)).toBe(true);
 });
 it('rejects missing actor and another employment before opening local enrollment storage',async()=>{
  const r=runtime(platform);await expect(r.open('11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa')).rejects.toBeInstanceOf(apple.EnrollmentJournalUnavailable);
  r.me.actorId='';await expect(r.open()).rejects.toBeInstanceOf(apple.EnrollmentJournalUnavailable);
  expect(r.installation).not.toHaveBeenCalled();expect(r.post).not.toHaveBeenCalled();expect(r.storage.openNativeEnrollmentJournal).not.toHaveBeenCalled();expect(r.storage.openNativeAndroidEnrollmentJournal).not.toHaveBeenCalled();
 });
 it.each(['actor','company','origin','lock','background'] as const)('stops an opened handle after %s changes',async(kind)=>{
  const r=runtime(platform),device=await r.open();
  if(kind==='actor')r.changeActor();if(kind==='company')r.changeCompany();if(kind==='origin')r.config.apiUrl='https://other.example.com';if(kind==='lock')r.lock();if(kind==='background')r.appState.currentState='background';
  await expect(device.begin()).rejects.toThrow();expect(r.f.stored()).toBeNull();expect(r.post).not.toHaveBeenCalled();
 });
 it('stops a late identity response before obtaining installation identity or opening a journal',async()=>{
  const r=runtime(platform);r.get.mockImplementationOnce(async()=>{r.changeActor();return structuredClone(r.me);});
  await expect(r.open()).rejects.toBeInstanceOf(errors.SessionChangedError);expect(r.installation).not.toHaveBeenCalled();expect(r.post).not.toHaveBeenCalled();
 });
 it('preserves the original intent when the server has not enabled the route and never generates a key',async()=>{
  const r=runtime(platform),device=await r.open();await device.begin();
  r.post.mockRejectedValueOnce(new errors.RequestRejectedError(404));await expect(device.advance()).rejects.toMatchObject({status:404});
  expect(r.post).toHaveBeenCalledOnce();expect(r.f.stored()?.pending).toMatchObject({phase:'requested',requestId:r.f.requestId});
  expect(r.a.native.generateAppleKey).not.toHaveBeenCalled();expect(r.d.native.create).not.toHaveBeenCalled();
  expect(await (await r.open()).status()).toMatchObject({status:'pending',phase:'requested',requestId:r.f.requestId});
 });
 it('retains requested intent if the app locks while preparation is in flight, with no SDK generation',async()=>{
  const r=runtime(platform),device=await r.open();await device.begin();
  const prepare=vi.mocked(r.f.ports.prepare),original=prepare.getMockImplementation()!;
  prepare.mockImplementationOnce(async(...args:unknown[])=>{const value=await Reflect.apply(original,undefined,args);r.lock();return value;});
  await expect(device.advance()).rejects.toBeInstanceOf(errors.UnavailableError);
  expect(r.f.stored()?.pending?.phase).toBe('requested');expect(r.a.native.generateAppleKey).not.toHaveBeenCalled();expect(r.d.native.create).not.toHaveBeenCalled();
 });
 it('recovers an accepted lost reply through the saved journal without repeating generation or upload',async()=>{
  const r=runtime(platform),device=await r.open();await device.begin();
  const complete=vi.mocked(r.f.ports.complete),original=complete.getMockImplementation()!;
  // The helper ports have platform-specific input types; the VM transport already validates them.
  complete.mockImplementationOnce(async(...args:unknown[])=>{await Reflect.apply(original,undefined,args);throw new errors.UnavailableError();});
  await expect(device.advance()).rejects.toBeInstanceOf(errors.UnavailableError);
  expect(r.f.stored()?.pending?.phase).toBe('proof_ready');
  expect(await (await r.open()).advance()).toMatchObject({status:'stored_key',revoked:false});
  expect(r.get).toHaveBeenCalledTimes(2);expect(complete).toHaveBeenCalledOnce();
  if(platform==='ios')expect(r.a.native.generateAppleKey).toHaveBeenCalledOnce();else expect(r.d.native.create).toHaveBeenCalledOnce();
 });
});
