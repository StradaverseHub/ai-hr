/** Native port models. Server revocation/OS storage acceptance is tested separately. */
import {describe,expect,it,vi} from 'vitest';
import {EnrollmentConflict,EnrollmentJournalUnavailable,parseEnrollmentSnapshot} from '../mobile/lib/enrollment-journal';
import {SessionChangedError} from '../mobile/lib/errors';
import {enrollmentFixture,enrollmentId} from './helpers/mobile-enrollment-fixture';
async function enrolled(){const f=enrollmentFixture();await f.journal().begin(f.employmentId,f.requestId);await f.journal().advance(f.employmentId);return f;}
describe('durable own-key revocation intent',()=>{
  it('commits intent before transport, preserves enrollment provenance and resolves only the same revoked receipt',async()=>{
    const f=await enrolled();let durable=false;const selected=enrollmentId(19);
    vi.mocked(f.ports.revoke).mockImplementationOnce(async()=>{durable=f.stored()?.version===2;f.setRevoked(true);return {outcome:'revoked',key:f.receipt()};});
    expect(await f.journal().revoke(selected)).toEqual({status:'stored_key',keyId:enrollmentId(8),revoked:true});
    expect(durable).toBe(true);expect(f.ports.revoke).toHaveBeenCalledExactlyOnceWith(selected,{keyId:enrollmentId(8)});
    expect(f.stored()?.key?.employmentId).toBe(f.employmentId);expect(f.stored()?.version).toBe(1);
    await f.journal().revoke(selected);expect(f.ports.revoke).toHaveBeenCalledOnce();
  });
  it('does not send revocation when saving intent fails',async()=>{
    const f=await enrolled();f.ports.commit=vi.fn(async()=>{throw new Error('storage failed');});
    await expect(f.journal().revoke(f.employmentId)).rejects.toBeInstanceOf(EnrollmentJournalUnavailable);
    expect(f.ports.revoke).not.toHaveBeenCalled();expect(f.stored()?.version).toBe(1);
  });
  it('retains intent after a lost server reply, prevents enrollment replacement and retries only explicitly',async()=>{
    const f=await enrolled();vi.mocked(f.ports.revoke).mockImplementationOnce(async()=>{f.setRevoked(true);throw new Error('reply lost');});
    await expect(f.journal().revoke(f.employmentId)).rejects.toThrow('reply lost');
    const pending={status:'revocation_pending',keyId:enrollmentId(8)};
    expect(await f.journal().status()).toEqual(pending);
    expect(await f.journal().begin(f.employmentId,enrollmentId(9))).toEqual(pending);
    expect(await f.journal().advance(f.employmentId)).toEqual(pending);
    expect(f.ports.revoke).toHaveBeenCalledOnce();expect(f.native.generateAppleKey).toHaveBeenCalledOnce();expect(f.native.attestAppleKey).toHaveBeenCalledOnce();
    expect(await f.journal().revoke(f.employmentId)).toMatchObject({status:'stored_key',revoked:true});
    expect(f.ports.revoke).toHaveBeenCalledTimes(2);
  });
  it('keeps intent through refused, unavailable and malformed responses without trusting local revocation',async()=>{
    for(const response of [{outcome:'refused',code:'subject_unavailable'},{outcome:'unavailable',code:'module_unavailable'},{outcome:'revoked',key:{}}]){
      const f=await enrolled();vi.mocked(f.ports.revoke).mockResolvedValueOnce(response);
      if(response.outcome==='revoked')await expect(f.journal().revoke(f.employmentId)).rejects.toBeInstanceOf(EnrollmentJournalUnavailable);
      else expect(await f.journal().revoke(f.employmentId)).toMatchObject({status:'revocation_pending',reason:response.outcome==='refused'?'server_refused':'server_unavailable'});
      expect(await f.journal().status()).toMatchObject({status:'revocation_pending'});expect(f.stored()?.key?.key.revokedAt).toBeNull();
    }
  });
  it('rejects another key, challenge, native binding, provenance or an unrevoked receipt',async()=>{
    for(const change of [{keyId:enrollmentId(9)},{originChallengeId:enrollmentId(9)},{nativeKeyBinding:'0'.repeat(64)},
      {appId:'ABCDEFGHIJ.other.app'},{proofKind:'apple_app_metadata'},{createdAt:'2026-10-28T00:00:00.000Z'},{revokedAt:null}]){
      const f=await enrolled();f.setRevoked(true);vi.mocked(f.ports.revoke).mockResolvedValueOnce({outcome:'revoked',key:{...f.receipt(),...change}});
      await expect(f.journal().revoke(f.employmentId)).rejects.toBeInstanceOf(EnrollmentConflict);
      expect(await f.journal().status()).toMatchObject({status:'revocation_pending'});expect(f.stored()?.key?.key.revokedAt).toBeNull();
    }
  });
  it('recovers revocation after a receipt-write failure without restoring active local status',async()=>{
    const f=await enrolled(),commit=f.ports.commit;
    f.ports.commit=vi.fn(async s=>{if(s.key?.key.revokedAt)throw new Error('receipt write failed');await commit(s);});
    await expect(f.journal().revoke(f.employmentId)).rejects.toBeInstanceOf(EnrollmentJournalUnavailable);
    expect(await f.journal().status()).toMatchObject({status:'revocation_pending'});
    f.ports.commit=commit;expect(await f.journal().revoke(f.employmentId)).toMatchObject({status:'stored_key',revoked:true});
  });
  it('reads a committed revoked receipt after an ambiguous local acknowledgement',async()=>{
    const f=await enrolled(),commit=f.ports.commit;
    f.ports.commit=vi.fn(async s=>{await commit(s);if(s.key?.key.revokedAt)throw new Error('ack lost');});
    await expect(f.journal().revoke(f.employmentId)).rejects.toBeInstanceOf(EnrollmentJournalUnavailable);
    expect(await f.journal().status()).toMatchObject({status:'stored_key',revoked:true});expect(f.ports.revoke).toHaveBeenCalledOnce();
  });
  it('refuses pending enrollment, cross-owner state and obsolete replies without clearing provenance',async()=>{
    const f=enrollmentFixture();await f.journal().begin(f.employmentId,f.requestId);
    await expect(f.journal().revoke(f.employmentId)).rejects.toBeInstanceOf(EnrollmentConflict);expect(f.ports.revoke).not.toHaveBeenCalled();
    const g=await enrolled();vi.mocked(g.ports.revoke).mockImplementationOnce(async()=>{g.changeOwner();g.setRevoked(true);return {outcome:'revoked',key:g.receipt()};});
    await expect(g.journal().revoke(g.employmentId)).rejects.toBeInstanceOf(SessionChangedError);expect(g.stored()?.version).toBe(2);expect(g.stored()?.key?.key.revokedAt).toBeNull();
  });
  it('rejects inconsistent version-two state while preserving version-one compatibility',async()=>{
    const f=await enrolled(),s=f.stored()!;
    expect(parseEnrollmentSnapshot(s,f.scope).version).toBe(1);
    for(const changed of [{...s,version:2},{...s,version:2,revocation:'requested',key:null},
      {...s,version:2,revocation:'requested',key:{...s.key,key:{...s.key!.key,revokedAt:'2026-10-28T00:00:00.000Z'}}}])
      expect(()=>parseEnrollmentSnapshot(changed,f.scope)).toThrow(EnrollmentJournalUnavailable);
  });
});
