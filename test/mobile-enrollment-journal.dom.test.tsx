import {describe,expect,it,vi} from 'vitest';
import {createEnrollmentJournal,EnrollmentConflict,EnrollmentJournalUnavailable} from '../mobile/lib/enrollment-journal';
import {SessionChangedError} from '../mobile/lib/errors';
import {enrollmentFixture,enrollmentId} from './helpers/mobile-enrollment-fixture';
describe('native enrollment durability and one-use recovery',()=>{
  it('commits intent and every irreversible stage before work, then clears proof only with a matching receipt',async()=>{
    const f=enrollmentFixture(),journal=f.journal();
    expect(await journal.begin(f.employmentId,f.requestId)).toMatchObject({phase:'requested',requestId:f.requestId});
    f.native.generateAppleKey.mockImplementationOnce(async()=>{expect(f.stored()?.pending?.phase).toBe('key_requested');f.setKey(f.vendorKeyId);return f.vendorKeyId;});
    f.native.attestAppleKey.mockImplementationOnce(async()=>{expect(f.stored()?.pending?.phase).toBe('attestation_requested');f.setCache({state:'completed',attestation:f.attestation});return f.attestation;});
    vi.mocked(f.ports.complete).mockImplementationOnce(async()=>{expect(f.stored()?.pending?.phase).toBe('proof_ready');return {outcome:'enrolled',key:f.receipt()};});
    expect(await journal.advance(f.employmentId)).toEqual({status:'stored_key',keyId:enrollmentId(8),revoked:false});
    expect(f.stored()?.pending).toBeNull();expect(JSON.stringify(f.stored())).not.toContain(f.attestation);
    expect(f.native.generateAppleKey).toHaveBeenCalledOnce();expect(f.native.attestAppleKey).toHaveBeenCalledExactlyOnceWith(f.vendorKeyId,f.prepared().clientDataHash);
  });
  it('quarantines persisted proof with trailing whitespace before server submission',async()=>{
    const f=enrollmentFixture(),journal=f.journal();await journal.begin(f.employmentId,f.requestId);
    vi.mocked(f.ports.complete).mockRejectedValueOnce(new Error('reply lost'));
    await expect(journal.advance(f.employmentId)).rejects.toThrow('reply lost');
    const stored=f.stored()!;if(stored.pending?.phase!=='proof_ready')throw new Error('missing fixture proof');
    stored.pending.attestation+='\n';f.setStored(stored);
    await expect(f.journal().advance(f.employmentId)).rejects.toBeInstanceOf(EnrollmentJournalUnavailable);
    expect(f.ports.complete).toHaveBeenCalledOnce();expect(f.native.attestAppleKey).toHaveBeenCalledOnce();
  });
  it('shares one queue across journal instances, preserves the first request and refuses employment adoption',async()=>{
    const f=enrollmentFixture(),a=f.journal(),b=f.journal();
    const [first,second]=await Promise.all([a.begin(f.employmentId,f.requestId),b.begin(f.employmentId,enrollmentId(9))]);expect(second).toEqual(first);
    await expect(b.advance(enrollmentId(9))).rejects.toBeInstanceOf(EnrollmentConflict);
    const [x,y]=await Promise.all([a.advance(f.employmentId),b.advance(f.employmentId)]);expect(y).toEqual(x);
    expect(f.native.generateAppleKey).toHaveBeenCalledOnce();expect(f.ports.complete).toHaveBeenCalledOnce();
  });
  it('stops before key generation when durable stage commit fails',async()=>{
    const f=enrollmentFixture(),journal=f.journal();await journal.begin(f.employmentId,f.requestId);
    const original=f.ports.commit;
    f.ports.commit=vi.fn(async value=>{if(value.pending?.phase==='key_requested')throw new Error('synthetic storage failure');await original(value);});
    await expect(journal.advance(f.employmentId)).rejects.toBeInstanceOf(EnrollmentJournalUnavailable);
    expect(f.native.generateAppleKey).not.toHaveBeenCalled();expect(f.stored()?.pending?.phase).toBe('prepared');
  });
  it('recovers a key reference after an ambiguous key reply without generating another key',async()=>{
    const f=enrollmentFixture(),journal=f.journal();await journal.begin(f.employmentId,f.requestId);
    f.native.generateAppleKey.mockImplementationOnce(async()=>{f.setKey(f.vendorKeyId);throw {code:'ERR_INTEGRITY_UNAVAILABLE'};});
    expect(await journal.advance(f.employmentId)).toMatchObject({phase:'key_requested',reason:'native_unavailable'});
    expect((await f.journal().advance(f.employmentId)).status).toBe('stored_key');expect(f.native.generateAppleKey).toHaveBeenCalledOnce();
  });
  it('keeps missing key references and unknown attestation calls unresolved rather than repeating irreversible work',async()=>{
    const f=enrollmentFixture(),journal=f.journal();await journal.begin(f.employmentId,f.requestId);
    f.native.generateAppleKey.mockRejectedValueOnce({code:'ERR_INTEGRITY_UNAVAILABLE'});
    await journal.advance(f.employmentId);expect(await f.journal().advance(f.employmentId)).toMatchObject({phase:'key_requested',reason:'recovery_required'});
    expect(f.native.generateAppleKey).toHaveBeenCalledOnce();expect(f.native.attestAppleKey).not.toHaveBeenCalled();
    f.setKey(f.vendorKeyId);f.native.attestAppleKey.mockImplementationOnce(async()=>{f.setCache({state:'requested'});throw {code:'ERR_INTEGRITY_RECOVERY_REQUIRED'};});
    await f.journal().advance(f.employmentId);expect(await f.journal().advance(f.employmentId)).toMatchObject({phase:'attestation_requested',reason:'recovery_required'});
    expect(f.native.attestAppleKey).toHaveBeenCalledOnce();
  });
  it('retries only a natively recorded outage under the same key and hash on an explicit later advance',async()=>{
    const f=enrollmentFixture(),journal=f.journal();await journal.begin(f.employmentId,f.requestId);
    f.native.attestAppleKey.mockImplementationOnce(async()=>{f.setCache({state:'retryable'});throw {code:'ERR_INTEGRITY_SERVER_UNAVAILABLE'};});
    expect(await journal.advance(f.employmentId)).toMatchObject({phase:'attestation_requested',reason:'vendor_outage'});
    expect((await f.journal().advance(f.employmentId)).status).toBe('stored_key');
    expect(f.native.attestAppleKey.mock.calls).toEqual(Array(2).fill([f.vendorKeyId,f.prepared().clientDataHash]));expect(f.native.generateAppleKey).toHaveBeenCalledOnce();
  });
  it('recovers native proof after its JS commit fails, and recovers a lost server reply before resending',async()=>{
    const f=enrollmentFixture(),journal=f.journal();await journal.begin(f.employmentId,f.requestId);const commit=f.ports.commit;
    f.ports.commit=vi.fn(async value=>{if(value.pending?.phase==='proof_ready')throw new Error('proof pointer failed');await commit(value);});
    await expect(journal.advance(f.employmentId)).rejects.toBeInstanceOf(EnrollmentJournalUnavailable);
    expect(f.ports.complete).not.toHaveBeenCalled();expect(f.stored()?.pending?.phase).toBe('attestation_requested');
    f.ports.commit=commit;vi.mocked(f.ports.complete).mockImplementationOnce(async()=>{f.setAccepted(true);throw new Error('response lost');});
    await expect(f.journal().advance(f.employmentId)).rejects.toThrow('response lost');
    f.setRevoked(true);expect(await f.journal().advance(f.employmentId)).toEqual({status:'stored_key',keyId:enrollmentId(8),revoked:true});
    expect(f.ports.complete).toHaveBeenCalledOnce();expect(f.native.attestAppleKey).toHaveBeenCalledOnce();
  });
  it('retains proof when receipt persistence fails and reconciles it without reloading enrollment configuration',async()=>{
    const f=enrollmentFixture(),journal=f.journal();await journal.begin(f.employmentId,f.requestId);const commit=f.ports.commit;
    f.ports.commit=vi.fn(async value=>{if(value.key)throw new Error('receipt pointer failed');await commit(value);});
    await expect(journal.advance(f.employmentId)).rejects.toBeInstanceOf(EnrollmentJournalUnavailable);
    expect(f.stored()?.pending?.phase).toBe('proof_ready');expect(f.stored()?.key).toBeNull();expect(f.ports.complete).toHaveBeenCalledOnce();expect(f.native.releaseAppleAttestation).not.toHaveBeenCalled();
    f.ports.commit=commit;vi.mocked(f.ports.prepare).mockRejectedValueOnce(new Error('configuration unavailable'));
    expect((await f.journal().advance(f.employmentId)).status).toBe('stored_key');
    expect(f.ports.prepare).toHaveBeenCalledOnce();expect(f.ports.complete).toHaveBeenCalledOnce();expect(f.native.attestAppleKey).toHaveBeenCalledOnce();
  });
  it('rejects transplanted, changed or mismatched prepared context before touching native keys',async()=>{
    for(const change of ['actor','origin','hash','alias'] as const){
      const f=enrollmentFixture(),journal=f.journal();await journal.begin(f.employmentId,f.requestId);const value=f.prepared();
      if(change==='actor')value.context.actorId=enrollmentId(9);if(change==='origin')value.context.apiOrigin='https://other.example.com';
      if(change==='hash')value.clientDataHash=Buffer.alloc(32,9).toString('base64');if(change==='alias')value.alias='aihr_'+'f'.repeat(64);
      vi.mocked(f.ports.prepare).mockResolvedValue(value);await expect(journal.advance(f.employmentId)).rejects.toBeInstanceOf(EnrollmentConflict);
      expect(f.native.generateAppleKey).not.toHaveBeenCalled();
    }
  });
  it('stops unsupported binaries, expired challenges and obsolete owners without fallback',async()=>{
    const f=enrollmentFixture(),journal=f.journal();await journal.begin(f.employmentId,f.requestId);
    f.setServerState('expired');expect(await journal.advance(f.employmentId)).toMatchObject({reason:'challenge_unavailable'});expect(f.native.generateAppleKey).not.toHaveBeenCalled();
    f.setServerState('active');f.ports.native.appleProofRecoverySupported=()=>false;
    expect(await f.journal().advance(f.employmentId)).toMatchObject({reason:'unsupported'});expect(f.native.generateAppleKey).not.toHaveBeenCalled();
    f.ports.native.appleProofRecoverySupported=()=>true;vi.mocked(f.ports.prepare).mockImplementationOnce(async()=>{f.changeOwner();return f.prepared();});
    await expect(f.journal().advance(f.employmentId)).rejects.toBeInstanceOf(SessionChangedError);expect(f.native.generateAppleKey).not.toHaveBeenCalled();
  });
  it('refuses cross-actor state and a receipt for another challenge without deleting the pending proof',async()=>{
    const f=enrollmentFixture(),journal=f.journal();await journal.begin(f.employmentId,f.requestId);
    await expect(createEnrollmentJournal({...f.scope,actorId:enrollmentId(9)},f.ports).status()).rejects.toBeInstanceOf(EnrollmentJournalUnavailable);
    vi.mocked(f.ports.complete).mockResolvedValue({outcome:'enrolled',key:{...f.receipt(),originChallengeId:enrollmentId(9)}});
    await expect(journal.advance(f.employmentId)).rejects.toBeInstanceOf(EnrollmentConflict);expect(f.stored()?.pending?.phase).toBe('proof_ready');
  });
  it('distinguishes unavailable key storage from a missing key and never repeats an uncertain attestation',async()=>{
    const f=enrollmentFixture(),journal=f.journal();await journal.begin(f.employmentId,f.requestId);
    f.native.generateAppleKey.mockImplementationOnce(async()=>{f.setKey(f.vendorKeyId);throw {code:'ERR_INTEGRITY_UNAVAILABLE'};});await journal.advance(f.employmentId);
    f.native.appleKeyInfo.mockRejectedValueOnce({code:'ERR_INTEGRITY_UNAVAILABLE'});
    expect(await f.journal().advance(f.employmentId)).toMatchObject({reason:'native_unavailable',phase:'key_requested'});
    f.native.attestAppleKey.mockRejectedValueOnce({code:'ERR_INTEGRITY_UNAVAILABLE'});await f.journal().advance(f.employmentId);
    expect(await f.journal().advance(f.employmentId)).toMatchObject({reason:'recovery_required',phase:'attestation_requested'});
    expect(f.native.generateAppleKey).toHaveBeenCalledOnce();expect(f.native.attestAppleKey).toHaveBeenCalledOnce();
  });
  it('does not adopt a refreshed nonce or generate a key for an explicitly unsupported build',async()=>{
    const f=enrollmentFixture(),journal=f.journal();await journal.begin(f.employmentId,f.requestId);
    f.native.generateAppleKey.mockRejectedValueOnce({code:'ERR_INTEGRITY_UNAVAILABLE'});await journal.advance(f.employmentId);
    f.context.nonce='B'+'A'.repeat(42);
    await expect(f.journal().advance(f.employmentId)).rejects.toBeInstanceOf(EnrollmentConflict);expect(f.native.generateAppleKey).toHaveBeenCalledOnce();
    const g=enrollmentFixture();g.context.target.requiredMetadata={validationCategory:4,bundleVersions:['other-build']};
    await g.journal().begin(g.employmentId,g.requestId);expect(await g.journal().advance(g.employmentId)).toMatchObject({reason:'unsupported'});expect(g.native.generateAppleKey).not.toHaveBeenCalled();
  });
  it('releases native bytes only after the matching key receipt is durable and retries deferred cleanup',async()=>{
    const f=enrollmentFixture(),journal=f.journal();await journal.begin(f.employmentId,f.requestId);
    let observedDurable=false;
    f.native.releaseAppleAttestation.mockImplementationOnce(async()=>{observedDurable=f.stored()?.pending===null&&f.stored()?.key?.key.nativeKeyBinding===f.receipt().nativeKeyBinding;throw {code:'ERR_INTEGRITY_UNAVAILABLE'};});
    expect((await journal.advance(f.employmentId)).status).toBe('stored_key');
    expect(observedDurable).toBe(true);
    expect((await f.journal().status()).status).toBe('stored_key');expect(f.native.releaseAppleAttestation).toHaveBeenCalledTimes(2);
    expect(f.native.attestAppleKey).toHaveBeenCalledOnce();expect(f.ports.complete).toHaveBeenCalledOnce();
  });
  it('refuses a receipt for another native key even when its challenge matches, and never clears that proof',async()=>{
    const f=enrollmentFixture(),journal=f.journal();await journal.begin(f.employmentId,f.requestId);
    vi.mocked(f.ports.complete).mockResolvedValue({outcome:'enrolled',key:{...f.receipt(),nativeKeyBinding:'0'.repeat(64)}});
    await expect(journal.advance(f.employmentId)).rejects.toBeInstanceOf(EnrollmentConflict);expect(f.stored()?.pending?.phase).toBe('proof_ready');expect(f.native.releaseAppleAttestation).not.toHaveBeenCalled();
    const g=enrollmentFixture();await g.journal().begin(g.employmentId,g.requestId);
    g.native.generateAppleKey.mockRejectedValueOnce({code:'ERR_INTEGRITY_UNAVAILABLE'});await g.journal().advance(g.employmentId);
    g.setAccepted(true);g.setKey(Buffer.alloc(32,9).toString('base64'));
    await expect(g.journal().advance(g.employmentId)).rejects.toBeInstanceOf(EnrollmentConflict);expect(g.native.releaseAppleAttestation).not.toHaveBeenCalled();
  });
  it('does not re-attest a released key when no matching receipt can be recovered',async()=>{
    const f=enrollmentFixture(),journal=f.journal();await journal.begin(f.employmentId,f.requestId);
    f.native.attestAppleKey.mockRejectedValueOnce({code:'ERR_INTEGRITY_UNAVAILABLE'});await journal.advance(f.employmentId);f.setCache({state:'released'});
    expect(await f.journal().advance(f.employmentId)).toMatchObject({phase:'attestation_requested',reason:'recovery_required'});expect(f.native.attestAppleKey).toHaveBeenCalledOnce();
  });
});
