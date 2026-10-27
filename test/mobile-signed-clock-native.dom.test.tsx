/** Execute the shipped assembly with the real journal/bridge/signing code; OS/network are synthetic. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {transpileModule,ModuleKind} from 'typescript';
import {describe,it,expect,vi} from 'vitest';
import * as C from '../lib/mobile-integrity-contract';
import * as contract from '../lib/mobile-api/contract';
import * as clockIntegrity from '../lib/mobile-clock-integrity';
import * as enrollment from '../mobile/lib/enrollment-journal';
import * as signingKey from '../mobile/lib/clock-signing-key';
import * as journal from '../mobile/lib/signed-clock-journal';
import * as errors from '../mobile/lib/errors';
import {createIntegrityBridge} from '../mobile/lib/integrity-bridge';
import {createAndroidClockSigner} from '../mobile/lib/android-clock-signing';
const actorId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',employmentId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',requestId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
function fixture(platform:'ios'|'android'){
 let unlocked=true,generation=1,accepted=false,stored:journal.SignedClockSnapshot|null=null;
 const config={apiUrl:'https://hr.example.com'},files=new Map<string,Uint8Array>([['restored',new Uint8Array([1,2,3])]]);
 const source={provider:null,mock:false,simulated:null,accessory:null},command={requestId,action:'in' as const,lat:3,lng:101,accuracy:5,sampledAt:1793055753390};
 const evidence={platform,appId:'ai.hr',appVersion:'1',buildVersion:'4',...source};
 const key={platform,apiOrigin:config.apiUrl,actorId,appInstallationId:actorId,installationId:actorId,tenantId:actorId,keyId:requestId,
  appId:platform==='ios'?'ABCDEFGHIJ.ai.hr':'ai.hr',nativeReference:platform==='ios'?Buffer.alloc(32,7).toString('base64'):'aihr_'+'a'.repeat(64)};
 const receipt={id:requestId,direction:'in',recordedAt:'2026-10-27T00:00:00.000Z',date:'2026-10-27',photoAvailable:true};
 const photo={sha256:createHash('sha256').update(files.get('restored')!).digest('hex'),byteLength:3,mimeType:'image/jpeg'};
 const entry={kind:'clock',requestId,command:JSON.stringify(command),digest:'a'.repeat(64),createdAt:command.sampledAt,integrity:{version:1,source},evidence:{digest:photo.sha256,size:3,mimeType:'image/jpeg',name:'photo',reference:requestId+'.sealed'}};
 const context={version:1,purpose:'attendance.clock.online',scope:{apiOrigin:config.apiUrl,installationId:actorId,tenantId:actorId,actorId,employmentId,deviceKeyId:requestId},
  challenge:{id:actorId,nonce:Buffer.alloc(32,8).toString('base64url'),expiresAt:1793055873390},command:{...command,photo},evidence};
 const base={pending:vi.fn(async()=>[entry]),restore:vi.fn(async()=>{files.set('restored',new Uint8Array([1,2,3]));return {command:entry.command,file:{uri:'restored',name:'photo',mimeType:'image/jpeg',size:3}};}),resolve:vi.fn(async()=>{})};
 const native={
  capabilities:vi.fn(()=>({version:1,platform,appId:'ai.hr',appVersion:'1',buildVersion:'4',keyMechanism:platform==='ios'?'apple_app_attest':'android_keystore'})),
  assertAppleKey:vi.fn(async(_key:string,_hash:string)=>Buffer.from('assertion').toString('base64')),
  signAndroidCommand:vi.fn(async(_alias:string,_envelope:string)=>Buffer.from('signature').toString('base64')),
  preparePlayIntegrity:vi.fn(async()=>null),requestPlayIntegrity:vi.fn(async()=> 'fresh-token'),
 };
 const handoff=vi.fn(async()=>key),append=vi.fn((form:FormData,name:string)=>form.append(name,'saved-photo-bytes'));
 const apiGet=vi.fn(async(path:string)=>{
  if(path==='me')return {actorId,employments:[{employmentId}]};
  if(path==='submission-receipt')return {kind:'clock',requestId,receipt:accepted?receipt:null};
  return {outcome:'capabilities',protocol:2,platform,commandProtocol:platform==='ios'?1:2,features:platform==='ios'?['online_clock_assertion']:['online_clock_signature','current_play_integrity'],offline:false,cloudProjectNumber:platform==='ios'?null:'123456789'};
 });
 const apiPost=vi.fn(async(path:string,body:FormData,_params:unknown,operation:{assertCurrent():void})=>{
  operation.assertCurrent();
  if(path.endsWith('/begin'))return {outcome:'prepared',protocol:platform==='ios'?1:2,state:'active',context};
  if(path.endsWith('/complete')){accepted=true;return {outcome:'accepted',receipt};}throw new Error(path);
 });
 class File{constructor(readonly uri:string){}get exists(){return files.has(this.uri);}delete(){files.delete(this.uri);}}
 const output={exports:{} as {openOwnedSignedClock:(employment:string,unlocked:()=>boolean)=>Promise<{status:()=>Promise<journal.SignedClockStatus>;start:(id:string)=>Promise<journal.SignedClockStatus>;advance:(requestId?:string)=>Promise<journal.SignedClockStatus>;recover:(abandon?:boolean,requestId?:string)=>Promise<journal.SignedClockStatus>}>}};
 runInNewContext(transpileModule(readFileSync('mobile/lib/signed-clock.ts','utf8'),{compilerOptions:{module:ModuleKind.CommonJS}}).outputText,{
  exports:output.exports,module:output,FormData,structuredClone,require:(id:string)=>{
   if(id==='react-native')return {AppState:{currentState:'active'},Platform:{OS:platform}};
   if(id==='expo-file-system')return {File};
   if(id==='../../lib/mobile-api/contract')return contract;
   if(id==='../../lib/mobile-clock-integrity')return clockIntegrity;
   if(id==='../../lib/mobile-integrity-contract')return C;
   if(id==='./api')return {apiGet,apiPost};
   if(id==='./auth')return {authGeneration:()=>generation,assertAuthGeneration:(n:number)=>{if(n!==generation)throw new errors.SessionChangedError();}};
   if(id==='./config')return {config,identityNamespace:()=> 'company'};
   if(id==='./errors')return errors;if(id==='./enrollment-journal')return enrollment;if(id==='./clock-signing-key')return signingKey;
   if(id==='./device-enrollment')return {openOwnedDeviceEnrollment:async()=>({signingKey:handoff})};
   if(id==='./submission-recovery')return {openOwnedClockJournal:async()=>base};
   if(id==='./submission-native')return {nativeIntegrityInstallationId:async()=>actorId,
    openNativeSignedClockJournal:async(scope:enrollment.EnrollmentScope,assertCurrent:()=>void,ports:journal.SignedClockPorts)=>journal.createSignedClockJournal(scope,{...ports,assertCurrent,read:async()=>stored,commit:async value=>{stored=structuredClone(value);}})};
   if(id==='./integrity-bridge')return {createIntegrityBridge};
   if(id==='./android-clock-signing')return {createAndroidClockSigner};
   if(id==='./clock-integrity')return {onlineClockClientDataHash:async(input:unknown,check:()=>void)=>{check();return createHash('sha256').update(clockIntegrity.onlineClockClientData(input)).digest('base64');}};
   if(id==='../modules/aihr-integrity/src/AihrIntegrityModule')return {default:native};
   if(id==='./capture')return {appendAttachment:append};
   if(id==='./signed-clock-journal')return journal;throw new Error(id);
  }});
 return {open:()=>output.exports.openOwnedSignedClock(employmentId,()=>unlocked),apiGet,apiPost,base,native,append,files,handoff,context,stored:()=>stored,
  lock:()=>{unlocked=false;},changeOwner:()=>{generation++;}};
}
describe('owned signed-clock native assembly',()=>{
 for(const platform of ['ios','android'] as const){
  it(platform+' binds exact saved multipart bytes to native proof and checks the accepted receipt',async()=>{
   const f=fixture(platform),controller=await f.open();expect(await controller.status()).toEqual({status:'empty'});
   expect(f.apiPost).not.toHaveBeenCalled();await controller.start(requestId);
   expect(await controller.advance()).toMatchObject({status:'accepted'});
   expect(f.apiPost.mock.calls.map(call=>call[0])).toEqual(['v2/integrity/'+platform+'/clock/begin','v2/integrity/'+platform+'/clock/complete']);
   const begin=f.apiPost.mock.calls[0][1],complete=f.apiPost.mock.calls[1][1];
   const {photo:_photo,...expectedCommand}=f.context.command;expect(JSON.parse(String(begin.get('command'))).command).toEqual(expectedCommand);
   expect(complete.get('photo')).toBe('saved-photo-bytes');expect(f.base.resolve).toHaveBeenCalledWith('clock',requestId);expect(f.files.size).toBe(0);
   const hash=createHash('sha256').update(clockIntegrity.onlineClockClientData(f.context)).digest();
   if(platform==='ios')expect(f.native.assertAppleKey).toHaveBeenCalledWith(expect.any(String),hash.toString('base64'));
   else{
    expect(f.native.requestPlayIntegrity).toHaveBeenCalledWith(hash.toString('base64url'));
    expect(complete.get('playIntegrityToken')).toBe('fresh-token');
    expect(Buffer.from(f.native.signAndroidCommand.mock.calls[0][1] as string,'base64').toString()).toBe(clockIntegrity.onlineClockClientData(f.context));
   }
   expect(JSON.stringify(f.stored())).not.toContain('fresh-token');
  });
 }
 it('keeps encrypted pending state and deletes its restored plaintext if privacy locks during restore',async()=>{
  const f=fixture('ios'),controller=await f.open();await controller.start(requestId);
  const restore=f.base.restore.getMockImplementation()!;f.base.restore.mockImplementationOnce(async()=>{const value=await restore();f.lock();return value;});
  await expect(controller.advance()).rejects.toBeInstanceOf(errors.UnavailableError);
  expect(f.files.size).toBe(0);expect(f.stored()?.pending?.phase).toBe('intent');expect(f.apiPost).not.toHaveBeenCalled();
 });
 it('prevents a stale controller from consulting keys, files or network after account change',async()=>{
  const f=fixture('android'),controller=await f.open();f.changeOwner();
  await expect(controller.start(requestId)).rejects.toBeInstanceOf(errors.SessionChangedError);
  expect(f.handoff).not.toHaveBeenCalled();expect(f.base.restore).not.toHaveBeenCalled();expect(f.apiPost).not.toHaveBeenCalled();
 });
});


it('the owned native adapter forwards expected request identity into the atomic journal operation',async()=>{
 const f=fixture('ios'),controller=await f.open();await controller.start(requestId);
 const reads=f.apiGet.mock.calls.length;
 await expect(controller.advance(actorId)).rejects.toBeInstanceOf(journal.SignedClockConflict);
 await expect(controller.recover(true,actorId)).rejects.toBeInstanceOf(journal.SignedClockConflict);
 expect(f.apiGet).toHaveBeenCalledTimes(reads);expect(f.apiPost).not.toHaveBeenCalled();expect(f.native.assertAppleKey).not.toHaveBeenCalled();
});
