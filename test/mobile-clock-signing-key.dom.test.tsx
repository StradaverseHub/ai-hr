import {describe,expect,it,vi} from 'vitest';
import {enrollmentFixture} from './helpers/mobile-enrollment-fixture';
import {androidEnrollmentFixture} from './helpers/mobile-android-enrollment-fixture';
describe('fresh signing key handoff from enrollment',()=>{
 it('hands off an existing Apple key only after fresh receipt and exact native alias lookup',async()=>{
  const f=enrollmentFixture(),j=f.journal();await j.begin(f.employmentId,f.requestId);await j.advance(f.employmentId);
  expect(await j.signingKey(f.employmentId)).toMatchObject({platform:'ios',actorId:f.scope.actorId,nativeReference:f.vendorKeyId,keyId:f.receipt().keyId});
  expect(f.ports.receipt).toHaveBeenLastCalledWith(f.employmentId,{originChallengeId:f.context.challengeId});
  expect(f.native.generateAppleKey).toHaveBeenCalledOnce();expect(f.native.attestAppleKey).toHaveBeenCalledOnce();
  f.setKey(Buffer.alloc(32,8).toString('base64'));await expect(j.signingKey(f.employmentId)).rejects.toThrow();
 });
 it('refuses revoked Apple keys and missing server receipts without generating a replacement',async()=>{
  const f=enrollmentFixture(),j=f.journal();await j.begin(f.employmentId,f.requestId);await j.advance(f.employmentId);
  f.setAccepted(false);await expect(j.signingKey(f.employmentId)).rejects.toThrow();
  f.setAccepted(true);f.setRevoked(true);await expect(j.signingKey(f.employmentId)).rejects.toThrow();
  expect(f.native.generateAppleKey).toHaveBeenCalledOnce();expect(f.ports.complete).toHaveBeenCalledOnce();
 });
 it('hands off Android alias only after receipt and exact existing SPKI reconciliation',async()=>{
  const f=androidEnrollmentFixture(),j=f.journal();await j.begin(f.employmentId,f.requestId);await j.advance(f.employmentId);
  expect(await j.signingKey(f.employmentId)).toMatchObject({platform:'android',actorId:f.scope.actorId,nativeReference:f.prepared().alias});
  expect(f.native.create).toHaveBeenCalledOnce();expect(f.native.read).toHaveBeenCalledOnce();
  f.native.read.mockResolvedValue({status:'evidence',evidence:{publicKeySpki:Buffer.alloc(91,9).toString('base64'),certificateChain:['YQ=='],reportedSecurityLevel:'unknown'},verification:'not_verified'});
  await expect(j.signingKey(f.employmentId)).rejects.toThrow();expect(f.ports.complete).toHaveBeenCalledOnce();
 });
 it('refuses pending, revoking, unavailable and revoked Android handoffs',async()=>{
  const f=androidEnrollmentFixture(),j=f.journal();await j.begin(f.employmentId,f.requestId);
  await expect(j.signingKey(f.employmentId)).rejects.toThrow();await j.advance(f.employmentId);
  vi.mocked(f.ports.receipt).mockResolvedValueOnce({outcome:'unavailable',code:'module_unavailable'});
  await expect(j.signingKey(f.employmentId)).rejects.toThrow();
  await j.revoke(f.employmentId);await expect(j.signingKey(f.employmentId)).rejects.toThrow();expect(f.native.create).toHaveBeenCalledOnce();
 });
});
