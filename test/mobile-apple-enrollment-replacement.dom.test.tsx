import {describe,expect,it,vi} from 'vitest';
import {EnrollmentConflict,EnrollmentJournalUnavailable,parseEnrollmentSnapshot} from '../mobile/lib/enrollment-journal';
import {appleReplacementFixture} from './helpers/mobile-apple-replacement-fixture';
import {enrollmentId as id} from './helpers/mobile-enrollment-fixture';
async function enrolled(){const f=appleReplacementFixture();await f.journal().begin(f.employmentId,f.requestId);await f.journal().advance(f.employmentId);return f;}
describe('explicit iPhone replacement with immutable retired enrollment history',()=>{
 it('preserves the original subject/context/receipt before preparing a distinct replacement',async()=>{
  const f=await enrolled();await f.journal().revoke(f.employmentId);const original=f.stored()!.key!;
  expect(f.stored()!.version).toBe(1);expect(await f.journal().replace(id(77),id(88))).toMatchObject({status:'pending',phase:'requested',employmentId:id(77),requestId:id(88)});
  const retired=f.stored()!;expect(retired.version).toBe(3);if(retired.version!==3)throw new Error('missing history');
  expect(retired.retired).toEqual([original]);expect(retired.key).toBeNull();expect(f.native.generateAppleKey).toHaveBeenCalledOnce();expect(f.ports.prepare).toHaveBeenCalledOnce();
  expect(await f.journal().advance(id(77))).toMatchObject({status:'stored_key',revoked:false});
  const next=f.stored()!;expect(next.version).toBe(3);if(next.version!==3)throw new Error('missing history');
  expect(next.retired).toEqual([original]);expect(next.key!.employmentId).toBe(id(77));expect(next.key!.key.keyId).not.toBe(original.key.keyId);
  expect(f.native.generateAppleKey).toHaveBeenCalledTimes(2);expect(f.native.attestAppleKey).toHaveBeenCalledTimes(2);
 });
 it('requires fresh server revocation and refuses an active, absent or unavailable receipt',async()=>{
  const f=await enrolled(),before=f.stored();
  expect(await f.journal().replace(f.employmentId,id(88))).toMatchObject({status:'stored_key',revoked:false,reason:'recovery_required'});expect(f.stored()).toEqual(before);
  for(const response of [{outcome:'key_receipt',key:null},{outcome:'unavailable',code:'module_unavailable'},{outcome:'refused',code:'subject_unavailable'}]){
   vi.mocked(f.ports.receipt).mockResolvedValueOnce(response);expect((await f.journal().replace(f.employmentId,id(88))).status).toBe('stored_key');expect(f.stored()).toEqual(before);
  }
  expect(f.native.generateAppleKey).toHaveBeenCalledOnce();expect(f.ports.complete).toHaveBeenCalledOnce();
 });
 it('does not trust a cached revocation when the returned receipt differs or appears active',async()=>{
  const f=await enrolled();await f.journal().revoke(f.employmentId);const before=f.stored(),key=before!.key!.key;
  for(const changed of [{...key,revokedAt:null},{...key,keyId:id(90)},{...key,nativeKeyBinding:'a'.repeat(64)}]){
   vi.mocked(f.ports.receipt).mockResolvedValueOnce({outcome:'key_receipt',key:changed});await expect(f.journal().replace(f.employmentId,id(88))).rejects.toBeInstanceOf(EnrollmentConflict);expect(f.stored()).toEqual(before);
  }
  expect(f.native.generateAppleKey).toHaveBeenCalledOnce();
 });
 it('does not start another key when retirement persistence fails, and recovers an ambiguous acknowledgement',async()=>{
  const f=await enrolled();await f.journal().revoke(f.employmentId);const commit=f.ports.commit,before=f.stored();
  f.ports.commit=vi.fn(async()=>{throw new Error('storage unavailable');});await expect(f.journal().replace(f.employmentId,id(88))).rejects.toBeInstanceOf(EnrollmentJournalUnavailable);
  expect(f.stored()).toEqual(before);expect(f.native.generateAppleKey).toHaveBeenCalledOnce();
  f.ports.commit=vi.fn(async value=>{await commit(value);throw new Error('acknowledgement lost');});
  await expect(f.journal().replace(f.employmentId,id(88))).rejects.toBeInstanceOf(EnrollmentJournalUnavailable);
  f.ports.commit=commit;expect(await f.journal().status()).toMatchObject({status:'pending',requestId:id(88)});
  await expect(f.journal().replace(f.employmentId,id(89))).rejects.toBeInstanceOf(EnrollmentConflict);
  expect(await f.journal().advance(f.employmentId)).toMatchObject({status:'stored_key',revoked:false});expect(f.native.generateAppleKey).toHaveBeenCalledTimes(2);
  expect(f.stored()!.version).toBe(3);
 });
 it('keeps retirement history when revocation intent and receipt are written again',async()=>{
  const f=await enrolled();await f.journal().revoke(f.employmentId);await f.journal().replace(f.employmentId,id(88));await f.journal().advance(f.employmentId);
  const before=f.stored()!;if(before.version!==3)throw new Error('missing history');
  vi.mocked(f.ports.revoke).mockRejectedValueOnce(new Error('request unavailable'));await expect(f.journal().revoke(f.employmentId)).rejects.toThrow('request unavailable');
  const pending=f.stored()!;expect(pending.version).toBe(3);if(pending.version!==3)throw new Error('missing history');expect(pending.revocation).toBe('requested');expect(pending.retired).toEqual(before.retired);
  await f.journal().revoke(f.employmentId);const after=f.stored()!;if(after.version!==3)throw new Error('missing history');expect(after.revocation).toBeUndefined();expect(after.retired).toEqual(before.retired);expect(after.key!.key.revokedAt).not.toBeNull();
 });
 it('bounds history without evicting predecessors or requesting a seventeenth key',async()=>{
  const f=await enrolled();
  for(let n=0;n<15;n++){await f.journal().revoke(f.employmentId);await f.journal().replace(f.employmentId,id(1000+n));await f.journal().advance(f.employmentId);}
  await f.journal().revoke(f.employmentId);const before=f.stored();
  expect(await f.journal().replace(f.employmentId,id(2000))).toMatchObject({status:'stored_key',revoked:true,reason:'history_full'});expect(f.stored()).toEqual(before);
  expect(f.native.generateAppleKey).toHaveBeenCalledTimes(16);expect(f.ports.prepare).toHaveBeenCalledTimes(16);
 });
 it('refuses duplicate identities, active history and foreign provenance instead of reinterpreting them',async()=>{
  const f=await enrolled();await f.journal().revoke(f.employmentId);await f.journal().replace(f.employmentId,id(88));await f.journal().advance(f.employmentId);
  const snapshot=f.stored()!;if(snapshot.version!==3)throw new Error('missing history');
  for(const mutation of [
   (s:typeof snapshot)=>{s.retired[0].key.revokedAt=null;},
   (s:typeof snapshot)=>{s.key!.requestId=s.retired[0].requestId;s.key!.prepared.context.requestId=s.retired[0].requestId;},
   (s:typeof snapshot)=>{s.key!.vendorKeyId=s.retired[0].vendorKeyId;},
   (s:typeof snapshot)=>{s.key!.prepared.context.challengeId=s.retired[0].prepared.context.challengeId;s.key!.key.originChallengeId=s.retired[0].key.originChallengeId;},
   (s:typeof snapshot)=>{s.key!.key.keyId=s.retired[0].key.keyId;},
   (s:typeof snapshot)=>{s.retired[0].prepared.context.actorId=id(99);},
   (s:typeof snapshot)=>{s.key=null;s.pending=null;},
  ]){const changed=structuredClone(snapshot);mutation(changed);expect(()=>parseEnrollmentSnapshot(changed,f.scope)).toThrow();}
  const tampered=structuredClone(snapshot);tampered.retired[0].key.nativeKeyBinding='a'.repeat(64);f.setStored(tampered);
  await expect(f.journal().status()).rejects.toBeInstanceOf(EnrollmentConflict);
 });
});
