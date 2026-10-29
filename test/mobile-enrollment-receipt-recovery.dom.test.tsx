import {describe,expect,it,vi} from 'vitest';
import {enrollmentFixture,enrollmentId} from './helpers/mobile-enrollment-fixture';
import {androidEnrollmentFixture} from './helpers/mobile-android-enrollment-fixture';
describe.each(['ios','android'] as const)('%s receipt-only enrollment recovery',platform=>{
 const fixture=()=>platform==='ios'?enrollmentFixture():androidEnrollmentFixture();
 it('retains a requested intent without preparing or creating anything',async()=>{
  const f=fixture(),j=f.journal();await j.begin(f.employmentId,f.requestId);const before=f.stored();
  expect(await j.reconcile(f.employmentId)).toMatchObject({status:'pending',phase:'requested'});expect(f.stored()).toEqual(before);
  expect(f.ports.prepare).not.toHaveBeenCalled();expect(f.ports.receipt).not.toHaveBeenCalled();expect(f.ports.complete).not.toHaveBeenCalled();expect(f.ports.revoke).not.toHaveBeenCalled();
 });
 it('does not interpret an absent receipt as permission to advance a prepared intent',async()=>{
  const f=fixture(),j=f.journal();await j.begin(f.employmentId,f.requestId);
  vi.mocked(f.ports.receipt).mockResolvedValueOnce({outcome:'unavailable',code:'module_unavailable'});
  expect(await j.advance(f.employmentId)).toMatchObject({status:'pending',phase:'prepared'});const before=f.stored();
  expect(await j.reconcile(enrollmentId(77))).toMatchObject({status:'pending',phase:'prepared'});expect(f.stored()).toEqual(before);
  expect(f.ports.prepare).toHaveBeenCalledOnce();expect(f.ports.complete).not.toHaveBeenCalled();expect(f.ports.revoke).not.toHaveBeenCalled();
  if('create' in f.native)expect(f.native.create).not.toHaveBeenCalled();else expect(f.native.generateAppleKey).not.toHaveBeenCalled();
 });
 it('recovers an accepted lost reply using only its receipt and saved binding',async()=>{
  const f=fixture(),j=f.journal();await j.begin(f.employmentId,f.requestId);
  const complete=vi.mocked(f.ports.complete),original=complete.getMockImplementation()!;
  complete.mockImplementationOnce(async(...args:unknown[])=>{await Reflect.apply(original,undefined,args);throw new Error('lost reply');});
  await expect(j.advance(f.employmentId)).rejects.toThrow('lost reply');expect(f.stored()?.pending?.phase).toBe('proof_ready');
  const prepareCount=vi.mocked(f.ports.prepare).mock.calls.length;
  expect(await f.journal().reconcile(enrollmentId(77))).toMatchObject({status:'stored_key',revoked:false});
  expect(f.stored()?.key?.employmentId).toBe(f.employmentId);expect(f.ports.complete).toHaveBeenCalledOnce();expect(f.ports.prepare).toHaveBeenCalledTimes(prepareCount);expect(f.ports.revoke).not.toHaveBeenCalled();
  expect(f.ports.receipt).toHaveBeenLastCalledWith(enrollmentId(77),{originChallengeId:f.context.challengeId});
 });
 it('keeps saved registration when its receipt is absent and refuses resurrection of revoked history',async()=>{
  const f=fixture(),j=f.journal();await j.begin(f.employmentId,f.requestId);await j.advance(f.employmentId);const original=f.stored();
  vi.mocked(f.ports.receipt).mockResolvedValueOnce({outcome:'key_receipt',key:null});
  expect(await j.reconcile(f.employmentId)).toMatchObject({status:'stored_key',revoked:false,reason:'recovery_required'});expect(f.stored()).toEqual(original);
  if('setRevoked' in f)f.setRevoked(true);else for(const key of f.records.values())key.revokedAt='2026-10-28T00:00:00.000Z';
  expect(await j.reconcile(f.employmentId)).toMatchObject({status:'stored_key',revoked:true});const revoked=f.stored();
  const key=revoked!.key!.key;vi.mocked(f.ports.receipt).mockResolvedValueOnce({outcome:'key_receipt',key:{...key,revokedAt:null}});
  await expect(j.reconcile(f.employmentId)).rejects.toThrow();expect(f.stored()).toEqual(revoked);
  expect(f.ports.complete).toHaveBeenCalledOnce();expect(f.ports.revoke).not.toHaveBeenCalled();
 });
 it('does not repeat a revocation command while checking its unresolved receipt',async()=>{
  const f=fixture(),j=f.journal();await j.begin(f.employmentId,f.requestId);await j.advance(f.employmentId);
  vi.mocked(f.ports.revoke).mockRejectedValueOnce(new Error('request unavailable'));await expect(j.revoke(f.employmentId)).rejects.toThrow('request unavailable');
  expect(await j.reconcile(f.employmentId)).toMatchObject({status:'revocation_pending'});expect(f.ports.revoke).toHaveBeenCalledOnce();
 });
});
