import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {inviteUser,retryAccountEmail,acceptInvitation,type AuthProvider} from '../core/auth';
import {readAccountEmailHistory} from '../core/account-email';
import * as s from '../db/schema';
let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const fake=():AuthProvider=>({sendInvitation:vi.fn().mockResolvedValue({invitationId:'fixture'}),sendPasswordReset:vi.fn().mockResolvedValue(undefined),revokeInvitation:vi.fn(),endSession:vi.fn(),emailReadiness:vi.fn().mockResolvedValue(null)});
describe('authorized account email history and explicit resend',()=>{
 it('uses local date boundaries, pages beyond the former 50-row limit and keeps same-timestamp rows distinct',async()=>{
  const ctx=adminCtx(b),provider=fake();
  for(let n=0;n<52;n++)await inviteUser(ctx,{email:`history-${n}@example.test`,role:'employee'},provider);
  await owner.db.update(s.accountEmailDelivery).set({createdAt:new Date('2026-10-26T17:00:00Z')});
  const first=await readAccountEmailHistory(ctx,undefined,{fromDate:'2026-10-27',toDate:'2026-10-27'});expect(first.items).toHaveLength(25);expect(first.hasMore).toBe(true);
  const second=await readAccountEmailHistory(ctx,undefined,{fromDate:'2026-10-27',toDate:'2026-10-27',before:first.nextCursor});expect(second.items).toHaveLength(25);
  const third=await readAccountEmailHistory(ctx,undefined,{fromDate:'2026-10-27',toDate:'2026-10-27',before:second.nextCursor});expect(third.items).toHaveLength(2);expect(third.hasMore).toBe(false);
  expect(new Set([...first.items,...second.items,...third.items].map(r=>r.id)).size).toBe(52);
  expect((await readAccountEmailHistory(ctx,undefined,{fromDate:'2026-10-26',toDate:'2026-10-26'})).items).toEqual([]);
  expect(await owner.db.select({id:s.accountEmailDelivery.id}).from(s.accountEmailDelivery)).toHaveLength(52);
 });
 it('resends one pending invitation with a fresh link, original role/scope and a retained single predecessor',async()=>{
  const ctx=adminCtx(b),provider=fake(),first=await inviteUser(ctx,{email:'resend@example.test',role:'super_admin'},provider);
  const original=(await readAccountEmailHistory(ctx)).items[0];expect(original.canRetry).toBe(true);
  const result=await Promise.allSettled([retryAccountEmail(ctx,original.id,true,undefined,provider),retryAccountEmail(ctx,original.id,true,undefined,provider)]);expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  const invitations=await owner.db.select().from(s.appInvitation);expect(invitations).toHaveLength(2);expect(invitations.find(i=>i.id===first.invitationId)?.status).toBe('revoked');expect(invitations.find(i=>i.status==='pending')).toMatchObject({role:'super_admin',companyId:null});
  expect(provider.sendInvitation).toHaveBeenCalledTimes(2);expect(vi.mocked(provider.sendInvitation).mock.calls[0][1]).not.toBe(vi.mocked(provider.sendInvitation).mock.calls[1][1]);
  expect((await readAccountEmailHistory(ctx)).items.find(i=>i.id===original.id)).toMatchObject({canRetry:false,resendUnavailable:'superseded'});
 });
 it('refuses resend after activation and hides other-tenant history and recovery data from HR roles',async()=>{
  const ctx=adminCtx(b),provider=fake(),created=await inviteUser(ctx,{email:'activated@example.test',role:'employee'},provider);
  await acceptInvitation({token:created.token,subject:'fixture-subject'});const [job]=await owner.db.select().from(s.accountEmailDelivery);
  await expect(retryAccountEmail(ctx,job.id,true,undefined,provider)).rejects.toThrow(/no longer pending/);
  expect((await readAccountEmailHistory(ctx)).items[0]).toMatchObject({canRetry:false,resendUnavailable:'closed'});
  expect((await readAccountEmailHistory({...ctx,tenantId:randomUUID()})).items).toEqual([]);
 });
 it('refuses malformed, mismatched-actor and inverted-range requests before querying history',async()=>{
  const ctx=adminCtx(b);
  await expect(readAccountEmailHistory(ctx,undefined,{fromDate:'2026-10-30',toDate:'2026-10-01'})).rejects.toThrow();
  await expect(readAccountEmailHistory(ctx,undefined,{before:'not-a-valid-page'})).rejects.toThrow();
  await expect(readAccountEmailHistory(ctx,{tenantId:ctx.tenantId,userId:randomUUID(),issuer:'https://example.test',subject:'other'})).rejects.toThrow(/does not match/);
 });
});
