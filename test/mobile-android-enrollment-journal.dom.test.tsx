import {describe,expect,it,vi} from 'vitest';
import {EnrollmentConflict,EnrollmentJournalUnavailable} from '../mobile/lib/enrollment-journal';
import {parseAndroidEnrollmentSnapshot} from '../mobile/lib/android-enrollment-journal';
import {SessionChangedError} from '../mobile/lib/errors';
import {androidEnrollmentFixture,androidEnrollmentId as id} from './helpers/mobile-android-enrollment-fixture';
describe('durable Android enrollment journal',()=>{
 it('commits intent, generation intent and exact proof before SDK/upload, then retains a matching receipt',async()=>{
  const f=androidEnrollmentFixture(),j=f.journal();expect(await j.begin(f.employmentId,f.requestId)).toMatchObject({phase:'requested'});
  expect(await j.advance(f.employmentId)).toEqual({status:'stored_key',keyId:id(500),revoked:false});
  expect(f.events).toEqual(['commit:requested','prepare','commit:prepared','receipt','commit:key_requested','sdk-create','commit:proof_ready','complete','commit:registered']);
  expect(f.stored()?.pending).toBeNull();expect(JSON.stringify(f.stored())).not.toContain(Buffer.from('private-synthetic-leaf').toString('base64'));
  expect(f.native.create).toHaveBeenCalledOnce();expect(f.native.read).not.toHaveBeenCalled();
 });
 it('recovers an uncertain generation by reading its saved alias after restart, never by generating again',async()=>{
  const f=androidEnrollmentFixture();await f.journal().begin(f.employmentId,f.requestId);
  f.native.create.mockImplementationOnce(async(input,persist)=>{await persist(input as Parameters<typeof persist>[0]);f.installKey(f.prepared().alias);return {status:'unavailable',reason:'timeout'};});
  expect(await f.journal().advance(f.employmentId)).toMatchObject({phase:'key_requested',reason:'native_unavailable'});
  vi.mocked(f.ports.prepare).mockRejectedValue(new Error('configuration unavailable'));
  expect(await f.journal().advance(f.employmentId)).toMatchObject({status:'stored_key'});expect(f.native.create).toHaveBeenCalledOnce();expect(f.native.read).toHaveBeenCalledOnce();
 });
 it('keeps an uncertain missing key pending without replacing it',async()=>{
  const f=androidEnrollmentFixture();await f.journal().begin(f.employmentId,f.requestId);
  f.native.create.mockImplementationOnce(async(input,persist)=>{await persist(input as Parameters<typeof persist>[0]);return {status:'unavailable',reason:'timeout'};});
  await f.journal().advance(f.employmentId);expect(await f.journal().advance(f.employmentId)).toMatchObject({phase:'key_requested',reason:'recovery_required'});expect(f.native.create).toHaveBeenCalledOnce();expect(f.ports.complete).not.toHaveBeenCalled();
 });
 it('recovers a lost accepted reply from the exact receipt before configuration or SDK calls',async()=>{
  const f=androidEnrollmentFixture(),complete=vi.mocked(f.ports.complete).getMockImplementation()!;await f.journal().begin(f.employmentId,f.requestId);
  vi.mocked(f.ports.complete).mockImplementationOnce(async(...args)=>{const value=await complete(...args);throw Object.assign(new Error('reply lost'),{syntheticResult:value});});
  await expect(f.journal().advance(f.employmentId)).rejects.toThrow('reply lost');expect(f.stored()?.pending?.phase).toBe('proof_ready');
  vi.mocked(f.ports.prepare).mockRejectedValue(new Error('policy changed'));expect(await f.journal().advance(f.employmentId)).toMatchObject({status:'stored_key'});
  expect(f.ports.complete).toHaveBeenCalledOnce();expect(f.ports.prepare).toHaveBeenCalledOnce();expect(f.native.create).toHaveBeenCalledOnce();expect(f.native.read).not.toHaveBeenCalled();
 });
 it('resends only saved proof after an absent receipt and never creates another key',async()=>{
  const f=androidEnrollmentFixture();await f.journal().begin(f.employmentId,f.requestId);
  vi.mocked(f.ports.complete).mockRejectedValueOnce(new Error('request lost'));await expect(f.journal().advance(f.employmentId)).rejects.toThrow('request lost');
  const first=vi.mocked(f.ports.complete).mock.calls[0][1];vi.mocked(f.ports.prepare).mockRejectedValue(new Error('not needed'));
  expect(await f.journal().advance(f.employmentId)).toMatchObject({status:'stored_key'});expect(vi.mocked(f.ports.complete).mock.calls[1][1]).toEqual(first);expect(f.native.create).toHaveBeenCalledOnce();
 });
 it('stops before SDK creation if durable generation intent cannot be committed',async()=>{
  const f=androidEnrollmentFixture(),commit=vi.mocked(f.ports.commit).getMockImplementation()!;await f.journal().begin(f.employmentId,f.requestId);
  vi.mocked(f.ports.commit).mockImplementation(async value=>{if(value.pending?.phase==='key_requested')throw new Error('storage failed');await commit(value);});
  await expect(f.journal().advance(f.employmentId)).rejects.toBeInstanceOf(EnrollmentJournalUnavailable);expect(f.keys.size).toBe(0);expect(f.ports.complete).not.toHaveBeenCalled();expect(f.stored()?.pending?.phase).toBe('prepared');
 });
 it('shares a scope queue across instances and never adopts another employment or replacement intent',async()=>{
  const f=androidEnrollmentFixture(),a=f.journal(),b=f.journal();const [x,y]=await Promise.all([a.begin(f.employmentId,f.requestId),b.begin(f.employmentId,id(9))]);expect(y).toEqual(x);
  expect(await b.advance(id(44))).toMatchObject({status:'pending',employmentId:f.employmentId,reason:'recovery_required'});expect(f.native.create).not.toHaveBeenCalled();const [m,n]=await Promise.all([a.advance(f.employmentId),b.advance(f.employmentId)]);expect(n).toEqual(m);expect(f.native.create).toHaveBeenCalledOnce();
 });
 it('recovers accepted history through a newer own subject without rewriting the original command',async()=>{
  const f=androidEnrollmentFixture(),complete=vi.mocked(f.ports.complete).getMockImplementation()!;await f.journal().begin(f.employmentId,f.requestId);
  vi.mocked(f.ports.complete).mockImplementationOnce(async(...args)=>{await complete(...args);throw new Error('reply lost');});
  await expect(f.journal().advance(f.employmentId)).rejects.toThrow('reply lost');expect(await f.journal().advance(id(44))).toMatchObject({status:'stored_key'});
  expect(f.ports.receipt).toHaveBeenLastCalledWith(id(44),{originChallengeId:f.context.challengeId});
  expect(f.stored()?.key?.employmentId).toBe(f.employmentId);expect(f.stored()?.key?.prepared.context.employmentId).toBe(f.employmentId);expect(f.ports.complete).toHaveBeenCalledOnce();
 });
 it('cannot submit retained proof or generate through a different employment when no accepted receipt exists',async()=>{
  const f=androidEnrollmentFixture();await f.journal().begin(f.employmentId,f.requestId);vi.mocked(f.ports.complete).mockRejectedValueOnce(new Error('request lost'));
  await expect(f.journal().advance(f.employmentId)).rejects.toThrow('request lost');
  expect(await f.journal().advance(id(44))).toMatchObject({status:'pending',employmentId:f.employmentId,phase:'proof_ready',reason:'recovery_required'});
  expect(f.ports.complete).toHaveBeenCalledOnce();expect(f.native.create).toHaveBeenCalledOnce();expect(f.native.read).not.toHaveBeenCalled();expect(f.ports.prepare).toHaveBeenCalledOnce();
 });
 it('quarantines cross-scope state and malformed retained proof before any server upload',async()=>{
  const f=androidEnrollmentFixture();await f.journal().begin(f.employmentId,f.requestId);vi.mocked(f.ports.complete).mockRejectedValueOnce(new Error('lost'));await expect(f.journal().advance(f.employmentId)).rejects.toThrow();
  const s=f.stored()!;expect(()=>parseAndroidEnrollmentSnapshot(s,{...f.scope,actorId:id(99)})).toThrow(EnrollmentJournalUnavailable);
  if(s.pending?.phase!=='proof_ready')throw new Error('missing proof');s.pending.proof.certificateChain[0]+='\n';f.setStored(s);
  await expect(f.journal().advance(f.employmentId)).rejects.toBeInstanceOf(EnrollmentJournalUnavailable);expect(f.ports.complete).toHaveBeenCalledOnce();
 });
 it('refuses a receipt for a different native public key instead of marking enrollment complete',async()=>{
  const f=androidEnrollmentFixture();await f.journal().begin(f.employmentId,f.requestId);
  vi.mocked(f.ports.complete).mockImplementationOnce(async()=>({outcome:'enrolled',key:f.makeReceipt(f.context.challengeId,Buffer.alloc(91,8).toString('base64'))}));
  await expect(f.journal().advance(f.employmentId)).rejects.toBeInstanceOf(EnrollmentConflict);expect(f.stored()?.pending?.phase).toBe('proof_ready');expect(f.stored()?.key).toBeNull();
 });
 it('persists revocation before transport and reconciles a lost reply without replaying it',async()=>{
  const f=androidEnrollmentFixture();await f.journal().begin(f.employmentId,f.requestId);await f.journal().advance(f.employmentId);const revoke=vi.mocked(f.ports.revoke).getMockImplementation()!;
  vi.mocked(f.ports.revoke).mockImplementationOnce(async(...args)=>{await revoke(...args);throw new Error('reply lost');});
  await expect(f.journal().revoke(f.employmentId)).rejects.toThrow('reply lost');expect(f.stored()?.version).toBe(2);
  expect(await f.journal().advance(f.employmentId)).toEqual({status:'stored_key',keyId:id(500),revoked:true});expect(f.ports.revoke).toHaveBeenCalledOnce();
 });
 it('requires confirmed server revocation for explicit replacement and preserves old enrollment history',async()=>{
  const f=androidEnrollmentFixture();await f.journal().begin(f.employmentId,f.requestId);await f.journal().advance(f.employmentId);
  expect(await f.journal().replace(f.employmentId,id(9))).toMatchObject({status:'stored_key',reason:'recovery_required'});expect(f.native.create).toHaveBeenCalledOnce();
  await f.journal().revoke(f.employmentId);expect(await f.journal().replace(id(44),id(9))).toMatchObject({status:'pending',employmentId:id(44),requestId:id(9)});
  expect(f.stored()?.retired).toHaveLength(1);expect(f.stored()?.retired[0].employmentId).toBe(f.employmentId);expect(f.stored()?.retired[0].key.revokedAt).not.toBeNull();
  expect(await f.journal().advance(id(44))).toMatchObject({status:'stored_key',keyId:id(501)});expect(f.native.create).toHaveBeenCalledTimes(2);
 });
 it('cannot publish an old owner response after account change',async()=>{
  const f=androidEnrollmentFixture(),j=f.journal();await j.begin(f.employmentId,f.requestId);
  vi.mocked(f.ports.prepare).mockImplementationOnce(async()=>{f.changeOwner();return f.prepared();});await expect(j.advance(f.employmentId)).rejects.toBeInstanceOf(SessionChangedError);expect(f.native.create).not.toHaveBeenCalled();expect(f.stored()?.pending?.phase).toBe('requested');
 });
});
