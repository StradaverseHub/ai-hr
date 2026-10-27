import {describe,expect,it,vi} from 'vitest';
import {createSignedClockJournal,parseSignedClockSnapshot,SignedClockConflict,type SignedClockPorts,type SignedClockSnapshot} from '../mobile/lib/signed-clock-journal';
const actorId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',employmentId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',requestId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const scope={namespace:'test',apiOrigin:'https://hr.example.com',actorId,appInstallationId:actorId};
const receipt={id:requestId,direction:'in' as const,recordedAt:'2026-10-27T00:00:00.000Z',date:'2026-10-27',photoAvailable:false};
function fixture(platform:'ios'|'android'='ios'){
 let stored:SignedClockSnapshot|null=null,accepted=false,abandoned=false,current=true;
 const source={provider:null,mock:null,simulated:null,accessory:null};
 const command={requestId,action:'in' as const,lat:3,lng:101,accuracy:5,sampledAt:1793055753390};
 const key={platform,apiOrigin:scope.apiOrigin,actorId,appInstallationId:actorId,installationId:actorId,tenantId:actorId,keyId:requestId,
  appId:platform==='ios'?'ABCDEFGHIJ.ai.hr':'ai.hr',nativeReference:platform==='ios'?Buffer.alloc(32,7).toString('base64'):'aihr_'+'a'.repeat(64)};
 const capability={version:1,platform,appId:'ai.hr',appVersion:'1.0',buildVersion:'4',keyMechanism:platform==='ios'?'apple_app_attest':'android_keystore'};
 const evidence={platform,appId:'ai.hr',appVersion:'1.0',buildVersion:'4',...source};
 const context={version:1,purpose:'attendance.clock.online',scope:{apiOrigin:scope.apiOrigin,installationId:actorId,tenantId:actorId,actorId,employmentId,deviceKeyId:requestId},
  challenge:{id:actorId,nonce:Buffer.alloc(32,8).toString('base64url'),expiresAt:1793055873390},command:{...command,photo:null},evidence};
 const proof=Buffer.from('proof').toString('base64');
 const ports:SignedClockPorts={
  assertCurrent(){if(!current)throw new Error('obsolete');},
  read:vi.fn(async()=>stored),commit:vi.fn(async value=>{stored=structuredClone(value);}),
  base:vi.fn(async()=>({digest:'a'.repeat(64),command,photo:null,source})),
  key:vi.fn(async()=>({key,capability})) as SignedClockPorts['key'],
  capabilities:vi.fn(async()=>({outcome:'capabilities',protocol:2,platform,commandProtocol:platform==='ios'?1:2,
   features:platform==='ios'?['online_clock_assertion']:['online_clock_signature','current_play_integrity'],offline:false,cloudProjectNumber:platform==='ios'?null:'123456789'})),
  begin:vi.fn(async()=>({outcome:'prepared',protocol:platform==='ios'?1:2,state:'active',context})),
  sign:vi.fn<SignedClockPorts['sign']>(async()=>({status:'evidence',evidence:proof,verification:'not_verified'})),
  play:vi.fn<SignedClockPorts['play']>(async()=>({status:'evidence',evidence:'ephemeral-token',verification:'not_verified'})),
  complete:vi.fn(async()=>{accepted=true;return {outcome:'accepted',receipt};}),
  receipt:vi.fn(async()=>({kind:'clock',requestId,receipt:accepted?receipt:null,...(abandoned?{abandoned:true}:{})})),
  abandon:vi.fn(async()=>{abandoned=!accepted;return {kind:'clock',requestId,receipt:accepted?receipt:null,abandoned};}),
  resolveBase:vi.fn(async()=>{}),
 };
 return {ports,journal:()=>createSignedClockJournal(scope,ports),stored:()=>stored,setStored:(value:SignedClockSnapshot|null)=>{stored=value;},context,proof,key,capability,
  accept:()=>{accepted=true;},obsolete:()=>{current=false;}};
}
describe('durable signed clock attempt ordering and recovery',()=>{
 for(const platform of ['ios','android'] as const){
  it(platform+' persists intent/context/proof before sending and resolves only accepted receipt',async()=>{
   const f=fixture(platform),j=f.journal();await j.start(employmentId,requestId);
   expect(f.stored()?.pending?.phase).toBe('intent');expect(f.ports.begin).not.toHaveBeenCalled();
   vi.mocked(f.ports.sign).mockImplementationOnce(async()=>{
    expect(f.stored()?.pending?.phase).toBe('prepared');return {status:'evidence',evidence:f.proof,verification:'not_verified'};
   });
   vi.mocked(f.ports.complete).mockImplementationOnce(async()=>{
    expect(f.stored()?.pending?.phase).toBe('sent');return {outcome:'accepted',receipt};
   });
   expect(await j.advance(employmentId)).toEqual({status:'accepted',receipt});
   expect(f.ports.resolveBase).toHaveBeenCalledWith({employmentId,requestId,baseDigest:'a'.repeat(64),action:'in'});
   expect(f.stored()?.pending).toBeNull();expect(JSON.stringify(f.stored())).not.toContain('ephemeral-token');
   expect(f.ports.play).toHaveBeenCalledTimes(platform==='android'?1:0);
  });
 }
 it('restarts after a dropped complete response without generating a second Apple assertion',async()=>{
  const f=fixture(),j=f.journal();await j.start(employmentId,requestId);
  vi.mocked(f.ports.complete).mockRejectedValueOnce(new Error('connection lost'));
  await expect(j.advance(employmentId)).rejects.toThrow('connection lost');expect(f.stored()?.pending?.phase).toBe('sent');
  await f.journal().advance(employmentId);expect(f.ports.sign).toHaveBeenCalledOnce();expect(f.ports.complete).toHaveBeenCalledTimes(2);
 });
 it('retains the exact Android signature when Play Integrity fails before the attendance upload',async()=>{
  const f=fixture('android'),j=f.journal();await j.start(employmentId,requestId);
  vi.mocked(f.ports.play).mockRejectedValueOnce(new Error('provider connection lost'));
  await expect(j.advance(employmentId)).rejects.toThrow('provider connection lost');
  expect(f.stored()?.pending).toMatchObject({phase:'proof_ready',proof:f.proof});expect(f.ports.complete).not.toHaveBeenCalled();
  expect(await f.journal().advance(employmentId)).toEqual({status:'accepted',receipt});
  expect(f.ports.sign).toHaveBeenCalledOnce();expect(f.ports.play).toHaveBeenCalledTimes(2);
  expect(f.ports.complete).toHaveBeenCalledOnce();
 });
 it('recovers accepted receipt after rollout, key and base files become unavailable',async()=>{
  const f=fixture(),j=f.journal();await j.start(employmentId,requestId);f.accept();
  for(const name of ['base','key','capabilities','begin'] as const)vi.mocked(f.ports[name]).mockRejectedValue(new Error('disabled'));
  expect(await f.journal().advance(employmentId)).toEqual({status:'accepted',receipt});
  expect(f.ports.sign).not.toHaveBeenCalled();expect(f.ports.complete).not.toHaveBeenCalled();
 });
 it('retains the settled receipt if base resolution fails and safely resumes cleanup',async()=>{
  const f=fixture(),j=f.journal();await j.start(employmentId,requestId);f.accept();
  vi.mocked(f.ports.resolveBase).mockRejectedValueOnce(new Error('locked'));
  await expect(j.recover(employmentId)).rejects.toThrow('locked');expect(f.stored()?.pending?.phase).toBe('settled');
  expect(await f.journal().recover(employmentId)).toEqual({status:'accepted',receipt});expect(f.stored()?.pending).toBeNull();
 });
 it('blocks another employment without exposing the old reference or creating a proof',async()=>{
  const f=fixture(),j=f.journal();await j.start(employmentId,requestId);
  expect(await f.journal().status(actorId)).toEqual({status:'other_pending'});
  expect(await f.journal().advance(actorId)).toEqual({status:'other_pending'});
  await expect(f.journal().start(actorId,actorId)).rejects.toBeInstanceOf(SignedClockConflict);
  expect(f.ports.receipt).not.toHaveBeenCalled();expect(f.ports.sign).not.toHaveBeenCalled();
 });
 it('serializes independently opened controllers across employments',async()=>{
  const f=fixture();
  const result=await Promise.allSettled([f.journal().start(employmentId,requestId),f.journal().start(actorId,actorId)]);
  expect(result.map(r=>r.status)).toEqual(['fulfilled','rejected']);expect(f.ports.commit).toHaveBeenCalledOnce();
 });
 it('does not treat a null lookup as permission to forget or replace an uncertain attempt',async()=>{
  const f=fixture(),j=f.journal();await j.start(employmentId,requestId);
  expect(await j.recover(employmentId)).toMatchObject({status:'pending',reason:'uncertain'});
  expect(f.ports.resolveBase).not.toHaveBeenCalled();
  expect(await j.recover(employmentId,true)).toEqual({status:'abandoned'});expect(f.stored()?.pending).toBeNull();
 });
 it('retains accepted attendance when abandonment loses to the server writer',async()=>{
  const f=fixture(),j=f.journal();await j.start(employmentId,requestId);f.accept();
  expect(await j.recover(employmentId,true)).toEqual({status:'accepted',receipt});
 });
 it('refuses command, scope, source and challenge substitution before native signing',async()=>{
  for(const changed of [
   {...fixture().context,command:{...fixture().context.command,lat:4}},
   {...fixture().context,scope:{...fixture().context.scope,actorId:employmentId}},
   {...fixture().context,evidence:{...fixture().context.evidence,mock:false}},
  ]){
   const f=fixture(),j=f.journal();await j.start(employmentId,requestId);
   vi.mocked(f.ports.begin).mockResolvedValue({outcome:'prepared',protocol:1,state:'active',context:changed});
   await expect(j.advance(employmentId)).rejects.toBeInstanceOf(SignedClockConflict);expect(f.ports.sign).not.toHaveBeenCalled();
  }
  const f=fixture(),j=f.journal();await j.start(employmentId,requestId);
  vi.mocked(f.ports.complete).mockRejectedValueOnce(new Error('lost'));await expect(j.advance(employmentId)).rejects.toThrow();
  vi.mocked(f.ports.begin).mockResolvedValue({outcome:'prepared',protocol:1,state:'active',context:{...f.context,challenge:{...f.context.challenge,id:requestId}}});
  await expect(f.journal().advance(employmentId)).rejects.toBeInstanceOf(SignedClockConflict);expect(f.ports.sign).toHaveBeenCalledOnce();
 });
 it('rejects a changed app build before generating the assertion',async()=>{
  const f=fixture(),j=f.journal();await j.start(employmentId,requestId);
  vi.mocked(f.ports.key).mockResolvedValue({...await f.ports.key(),capability:{...f.capability,buildVersion:'5'}} as Awaited<ReturnType<SignedClockPorts['key']>>);
  await expect(j.advance(employmentId)).rejects.toBeInstanceOf(SignedClockConflict);expect(f.ports.sign).not.toHaveBeenCalled();
 });
 it('does not send or sign after an ambiguous prepared-state commit or owner loss',async()=>{
  const f=fixture(),j=f.journal();await j.start(employmentId,requestId);
  vi.mocked(f.ports.commit).mockImplementationOnce(async value=>{f.setStored(structuredClone(value));throw new Error('write acknowledgement lost');});
  await expect(j.advance(employmentId)).rejects.toThrow('write acknowledgement lost');expect(f.ports.sign).not.toHaveBeenCalled();
  f.obsolete();await expect(f.journal().advance(employmentId)).rejects.toThrow('obsolete');expect(f.ports.complete).not.toHaveBeenCalled();
 });
 it('refuses corrupt phase/proof, cross-account and project data rather than opening an empty lease',async()=>{
  const f=fixture();await f.journal().start(employmentId,requestId);const stored=f.stored()!;
  for(const change of [{scope:{...scope,actorId:employmentId}},{pending:{...stored.pending,phase:'proof_ready'}},{pending:{...stored.pending,project:'123\n'}},{pending:{...stored.pending,proof:'AB=='}}])
   expect(()=>parseSignedClockSnapshot({...stored,...change},scope)).toThrow('Signed clocking unavailable');
 });
});


describe('atomic expected-request ownership',()=>{
 it('refuses a different current lease before receipt lookup, abandonment or signing',async()=>{
  const f=fixture(),j=f.journal();await j.start(employmentId,requestId);
  await expect(j.advance(employmentId,actorId)).rejects.toBeInstanceOf(SignedClockConflict);
  await expect(j.recover(employmentId,false,actorId)).rejects.toBeInstanceOf(SignedClockConflict);
  await expect(j.recover(employmentId,true,actorId)).rejects.toBeInstanceOf(SignedClockConflict);
  expect(f.ports.receipt).not.toHaveBeenCalled();expect(f.ports.abandon).not.toHaveBeenCalled();expect(f.ports.sign).not.toHaveBeenCalled();
  expect(f.stored()?.pending?.requestId).toBe(requestId);
 });
});


describe('signed clock safe refusal and provider outcomes',()=>{
 it('retains only bounded public refusal codes from begin without generating a proof',async()=>{
  const f=fixture(),j=f.journal();await j.start(employmentId,requestId);
  vi.mocked(f.ports.begin).mockResolvedValue({outcome:'refused',code:'outside_geofence',locationReason:'outside_site',vendorToken:'private'});
  const result=await j.advance(employmentId);
  expect(result).toMatchObject({status:'pending',phase:'intent',reason:'refused',refusal:{code:'outside_geofence',locationReason:'outside_site'}});
  expect(JSON.stringify(result)).not.toContain('private');expect(f.ports.sign).not.toHaveBeenCalled();expect(f.ports.resolveBase).not.toHaveBeenCalled();
 });
 it('retains the sent proof after explicit server refusal instead of treating it as settled',async()=>{
  const f=fixture(),j=f.journal();await j.start(employmentId,requestId);
  vi.mocked(f.ports.complete).mockResolvedValue({outcome:'refused',code:'invalid_proof',integrityReason:'reported_mock',privateReport:{secret:'private'}});
  expect(await j.advance(employmentId)).toMatchObject({status:'pending',phase:'sent',reason:'refused',refusal:{code:'invalid_proof',integrityReason:'reported_mock'}});
  expect(f.stored()?.pending?.phase).toBe('sent');expect(f.ports.resolveBase).not.toHaveBeenCalled();
 });
 it.each([
  [{status:'unsupported',reason:'unsupported'},'unsupported'],
  [{status:'invalid',reason:'invalid_key'},'invalid_evidence'],
  [{status:'unavailable',reason:'server_unavailable'},'native_unavailable'],
 ] as const)('keeps %s distinct without uploading or discarding the retained command',async(native,reason)=>{
  const f=fixture(),j=f.journal();await j.start(employmentId,requestId);vi.mocked(f.ports.sign).mockResolvedValue(native);
  expect(await j.advance(employmentId)).toMatchObject({status:'pending',phase:'prepared',reason});expect(f.ports.complete).not.toHaveBeenCalled();expect(f.ports.resolveBase).not.toHaveBeenCalled();
 });
});

it('refuses a native bundle that is only a suffix of the registered Apple App ID before reserving an online proof',async()=>{
 const f=fixture();vi.mocked(f.ports.key).mockResolvedValueOnce({...await f.ports.key(),capability:{...f.capability,appId:'hr'}} as Awaited<ReturnType<SignedClockPorts['key']>>);
 await expect(f.journal().start(employmentId,requestId)).rejects.toBeInstanceOf(SignedClockConflict);expect(f.stored()).toBeNull();expect(f.ports.begin).not.toHaveBeenCalled();expect(f.ports.sign).not.toHaveBeenCalled();
});
