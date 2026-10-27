import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {inviteUser,retryAccountEmail,acceptInvitation,revokeInvitation,type AuthProvider} from '../core/auth';
import {readAccountEmailHistory} from '../core/account-email';
import {readAccountEmailRetention,saveAccountEmailRetention} from '../core/account-email-retention';
import {withTenant} from '../db/client';
import * as s from '../db/schema';
let b:Base;
beforeAll(async()=>{
 await migrateTestDb();
 // 0641 is centrally reserved; its journal slot belongs to final integration. Exercise the exact
 // future DDL in this disposable hosted fixture without inventing or editing journal history.
 const [existing]=await owner.client`select to_regprocedure('app.account_email_history(text,text,date,date,text,timestamp with time zone,uuid)') is not null installed`;
 if(!existing.installed)for(const statement of readFileSync('db/migrations/0641_account_email_delivery_history.sql','utf8').split('--> statement-breakpoint'))if(statement.trim())await owner.client.unsafe(statement);
});beforeEach(async()=>{await resetDb();b=await seedBase();await owner.client`update account_email_retention set days=null,revision=0,last_run_at=null,last_deleted=0`;});afterAll(async()=>{await owner.client`update account_email_retention set days=null,revision=0,last_run_at=null,last_deleted=0`;await closeAll();});
const fake=():AuthProvider=>({sendInvitation:vi.fn().mockResolvedValue({invitationId:'fixture'}),sendPasswordReset:vi.fn().mockResolvedValue(undefined),revokeInvitation:vi.fn(),endSession:vi.fn(),emailReadiness:vi.fn().mockResolvedValue(null)});
async function operator(){
 const actor={userId:b.adminUserId,tenantId:b.tenantId,issuer:'https://hr.test/identity/realms/ai-hr',subject:randomUUID()};
 await owner.db.insert(s.appExternalIdentity).values({issuer:actor.issuer,subject:actor.subject,appUserId:actor.userId});
 await owner.db.insert(s.deploymentIdentityOperator).values({issuer:actor.issuer,subject:actor.subject,testEmail:'operator@example.test'});return actor;
}
async function recovery(days:number,parent:string|null=null,pending=false){
 const id=randomUUID();
 await owner.client`insert into account_email_delivery(id,tenant_id,kind,recovery_email,replaces_delivery_id,status,last_error,lease_token,lease_until,created_at,updated_at)
 values(${id}::uuid,'00000000-0000-0000-0000-000000000000','recovery','history-fixture@example.test',${parent}::uuid,${pending?'pending':'failed'}::notification_delivery_status,${pending?null:'relayUnavailable'},${pending?randomUUID():null}::uuid,${pending?new Date(Date.now()+60000).toISOString():null}::timestamptz,now()-make_interval(days=>${days}),now()-make_interval(days=>${days}))`;
 return id;
}
describe('authorized account email history and explicit resend',()=>{
 it('uses local date boundaries, pages beyond the former 50-row limit and keeps same-timestamp rows distinct',async()=>{
  const ctx=adminCtx(b),provider=fake();
  for(let n=0;n<52;n++)await inviteUser(ctx,{email:`history-${n}@example.test`,role:'employee'},provider);
  await owner.client`update account_email_delivery set created_at='2026-10-26T17:00:00.123456Z'::timestamptz`;
  const first=await readAccountEmailHistory(ctx,undefined,{fromDate:'2026-10-27',toDate:'2026-10-27'});expect(first.items).toHaveLength(25);expect(first.hasMore).toBe(true);
  expect(JSON.parse(Buffer.from(first.nextCursor!,'base64url').toString())[0]).toBe('2026-10-26T17:00:00.123456Z');
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
 it('defaults to indefinite retention and requires an exact installation operator, acknowledgement and current revision',async()=>{
  const ctx=adminCtx(b),actor=await operator();await recovery(100);
  expect(await readAccountEmailRetention(ctx,actor)).toMatchObject({days:null,revision:0,lastRunAt:null});
  expect((await owner.client`select app.account_email_retention_prune() removed`)[0].removed).toBe(0);
  expect(await owner.db.select().from(s.accountEmailDelivery)).toHaveLength(1);
  await expect(saveAccountEmailRetention(ctx,actor,{days:30,revision:0,acknowledged:false})).rejects.toThrow(/Acknowledge/);
  await expect(saveAccountEmailRetention(ctx,actor,{days:0,revision:0,acknowledged:true})).rejects.toThrow();
  await expect(readAccountEmailRetention(ctx,{...actor,userId:randomUUID()})).rejects.toThrow(/does not match/);
  await expect(readAccountEmailRetention(ctx,{...actor,subject:'not-enrolled'})).rejects.toMatchObject({cause:{code:'42501'}});
  await expect(withTenant(ctx,tx=>tx.execute(sql`select app.account_email_retention_prune()`))).rejects.toMatchObject({cause:{code:'42501'}});
  await expect(withTenant(ctx,tx=>tx.execute(sql`select * from account_email_retention`))).rejects.toMatchObject({cause:{code:'42501'}});
  await expect(withTenant(ctx,tx=>tx.execute(sql`delete from account_email_delivery`))).rejects.toMatchObject({cause:{code:'42501'}});
  await expect(withTenant(ctx,tx=>tx.execute(sql`select app.account_email_retention_save(${actor.issuer},${actor.subject},30,0,false)`))).rejects.toMatchObject({cause:{code:'P0001',message:expect.stringContaining('acknowledgement')}});
  await saveAccountEmailRetention(ctx,actor,{days:30,revision:0,acknowledged:true});
  await expect(saveAccountEmailRetention(ctx,actor,{days:7,revision:0,acknowledged:true})).rejects.toMatchObject({cause:{code:'P0001',message:expect.stringContaining('changed')}});
  expect(await readAccountEmailRetention(ctx,actor)).toMatchObject({days:30,revision:1});
  await owner.db.update(s.deploymentIdentityOperator).set({revokedAt:new Date()});
  await expect(saveAccountEmailRetention(ctx,actor,{days:null,revision:1,acknowledged:false})).rejects.toMatchObject({cause:{code:'42501'}});
 });
 it('prunes only whole inactive chains and preserves pending sends, recent activity, usable invitations, accounts and audit',async()=>{
  const ctx=adminCtx(b),actor=await operator(),provider=fake();
  const closed=await inviteUser(ctx,{email:'closed-history@example.test',role:'employee'},provider);await revokeInvitation(ctx,{invitationId:closed.invitationId});
  const usable=await inviteUser(ctx,{email:'usable-history@example.test',role:'employee'},provider);
  await owner.client`update account_email_delivery set created_at=now()-interval '31 days',updated_at=now()-interval '31 days' where kind='invitation'`;
  const old=await recovery(31),oldChild=await recovery(31,old),protectedRoot=await recovery(31),recentChild=await recovery(0,protectedRoot),pending=await recovery(31,null,true);
  await saveAccountEmailRetention(ctx,actor,{days:30,revision:0,acknowledged:true});
  const events=await owner.db.select({id:s.domainEvent.id}).from(s.domainEvent),users=await owner.db.select({id:s.appUser.id}).from(s.appUser);
  const [{removed}]=await owner.client`select app.account_email_retention_prune() removed`;expect(removed).toBe(3);
  const retained=await owner.db.select().from(s.accountEmailDelivery);expect(retained.map(r=>r.id)).toEqual(expect.arrayContaining([protectedRoot,recentChild,pending]));
  expect(retained.some(r=>r.id===old||r.id===oldChild||r.invitationId===closed.invitationId)).toBe(false);
  expect(retained.some(r=>r.invitationId===usable.invitationId)).toBe(true);
  expect(await owner.db.select({id:s.appUser.id}).from(s.appUser)).toEqual(users);
  expect(await owner.db.select().from(s.appInvitation)).toHaveLength(2);
  const after=await owner.db.select({id:s.domainEvent.id}).from(s.domainEvent);expect(after.map(e=>e.id)).toEqual(expect.arrayContaining(events.map(e=>e.id)));expect(after).toHaveLength(events.length+1);
  expect(await readAccountEmailRetention(ctx,actor)).toMatchObject({days:30,lastDeleted:3,lastRunAt:expect.any(String)});
  expect((await owner.client`select app.account_email_retention_prune() removed`)[0].removed).toBe(0);
  await saveAccountEmailRetention(ctx,actor,{days:null,revision:1,acknowledged:false});
  expect((await readAccountEmailRetention(ctx,actor)).days).toBeNull();
 });
});
