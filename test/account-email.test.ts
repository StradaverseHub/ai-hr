import {randomUUID,createHash} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,describe,it,expect,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {adminCtx,closeAll,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {client,withTenant} from '../db/client';
import {inviteUser,requestPasswordReset,retryAccountEmail,acceptInvitation,revokeInvitation,type AuthProvider} from '../core/auth';
import {readAccountEmailDeliveries} from '../core/account-email';
import * as s from '../db/schema';

let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const fake=()=>({sendInvitation:vi.fn().mockResolvedValue({invitationId:'provider-invitation'}),sendPasswordReset:vi.fn().mockResolvedValue(undefined),revokeInvitation:vi.fn().mockResolvedValue(undefined),endSession:vi.fn().mockResolvedValue(undefined),emailReadiness:vi.fn().mockResolvedValue('relayUnavailable')} satisfies AuthProvider);
const jobs=()=>owner.db.select().from(s.accountEmailDelivery).orderBy(s.accountEmailDelivery.createdAt,s.accountEmailDelivery.id);
async function operator(){
 const actor={userId:b.adminUserId,tenantId:b.tenantId,issuer:'https://hr.test/identity/realms/ai-hr',subject:randomUUID()};
 await owner.db.insert(s.appExternalIdentity).values({issuer:actor.issuer,subject:actor.subject,appUserId:actor.userId});
 await owner.db.insert(s.deploymentIdentityOperator).values({issuer:actor.issuer,subject:actor.subject,testEmail:'owner@example.test'});return actor;
}
describe('account requests independent of SMTP delivery',()=>{
 it('commits an invitation without SMTP, records a failed email and stores no raw authentication link',async()=>{
  const provider=fake(),created=await inviteUser(adminCtx(b),{email:'new@example.test',role:'employee'},provider);
  const [invitation]=await owner.db.select().from(s.appInvitation).where(eq(s.appInvitation.id,created.invitationId));
  expect(invitation).toMatchObject({status:'pending',role:'employee',email:'new@example.test'});
  expect(invitation.tokenHash).toBe(createHash('sha256').update(created.token).digest('hex'));
  const [job]=await jobs();expect(job).toMatchObject({kind:'invitation',invitationId:created.invitationId,status:'failed',lastError:'relayUnavailable',attempts:1,startedAt:null,leaseToken:null,leaseUntil:null,recoveryEmail:null});
  expect(provider.sendInvitation).not.toHaveBeenCalled();expect(JSON.stringify(job)).not.toContain(created.token);
  const events=await owner.db.select().from(s.domainEvent);expect(JSON.stringify(events)).not.toContain(created.token);expect(JSON.stringify(events)).not.toContain('/invite/');
 });
 it('does not replay on SMTP activation and reissues only the selected invitation with its original permissions',async()=>{
  const ctx={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]},provider=fake();
  const first=await inviteUser(ctx,{email:'first@example.test',role:'performance_comp_partner',companyId:b.companyId},provider);
  const second=await inviteUser(ctx,{email:'second@example.test',role:'employee'},provider);
  const original=(await jobs()).find(job=>job.invitationId===first.invitationId)!;
  provider.emailReadiness.mockResolvedValue(null);expect((await readAccountEmailDeliveries(ctx)).every(job=>job.status==='failed')).toBe(true);expect(provider.sendInvitation).not.toHaveBeenCalled();
  await retryAccountEmail(ctx,original.id,true,undefined,provider);expect(provider.sendInvitation).toHaveBeenCalledOnce();
  const all=await jobs(),replacement=all.find(job=>job.replacesDeliveryId===original.id)!;
  expect(replacement).toMatchObject({status:'sent',lastError:null,attempts:1});expect(all.find(job=>job.invitationId===second.invitationId)).toMatchObject({status:'failed',lastError:'relayUnavailable'});
  const [old]=await owner.db.select().from(s.appInvitation).where(eq(s.appInvitation.id,first.invitationId));expect(old.status).toBe('revoked');
  const [fresh]=await owner.db.select().from(s.appInvitation).where(eq(s.appInvitation.id,replacement.invitationId!));
  expect(fresh).toMatchObject({status:'pending',email:old.email,role:old.role,companyId:old.companyId,personId:old.personId});expect(fresh.tokenHash).not.toBe(old.tokenHash);
  await expect(acceptInvitation({token:first.token,subject:'replayed-subject'})).rejects.toThrow();
  expect((await readAccountEmailDeliveries(ctx)).find(job=>job.id===original.id)?.canRetry).toBe(false);
  await expect(retryAccountEmail(ctx,original.id,true,undefined,provider)).rejects.toThrow(/replacement/);expect(provider.sendInvitation).toHaveBeenCalledOnce();
 });
 it('refuses missing acknowledgement, company-only administrators and another tenant without sending',async()=>{
  const provider=fake();await inviteUser(adminCtx(b),{email:'private@example.test',role:'employee'},provider);const [job]=await jobs();
  await expect(retryAccountEmail(adminCtx(b),job.id,false,undefined,provider)).rejects.toThrow(/Confirm/);
  const scoped={...adminCtx(b),grants:[{role:'hr_admin',companyId:b.companyId}]};expect(await readAccountEmailDeliveries(scoped)).toEqual([]);
  await expect(retryAccountEmail(scoped,job.id,true,undefined,provider)).rejects.toThrow();
  const foreign=await seedBase();await expect(retryAccountEmail({...adminCtx(foreign),entitlements:harnessSnapshot(foreign.tenantId)},job.id,true,undefined,provider)).rejects.toThrow();
  expect(provider.sendInvitation).not.toHaveBeenCalled();expect((await jobs())[0]).toMatchObject({status:'failed',attempts:1});
 });
 it('never reissues accepted or revoked invitations even when their email attempt failed',async()=>{
  const provider=fake(),ctx=adminCtx(b);
  const accepted=await inviteUser(ctx,{email:'accepted@example.test',role:'employee'},provider);
  const revoked=await inviteUser(ctx,{email:'revoked@example.test',role:'employee'},provider);
  await acceptInvitation({token:accepted.token,subject:'accepted-subject'});await revokeInvitation(ctx,{invitationId:revoked.invitationId});
  for(const job of await jobs())await expect(retryAccountEmail(ctx,job.id,true,undefined,provider)).rejects.toThrow(/no longer pending/);
  expect((await readAccountEmailDeliveries(ctx)).every(job=>!job.canRetry)).toBe(true);expect(provider.sendInvitation).not.toHaveBeenCalled();
 });
 it('records known and unknown recovery requests identically without SMTP and keeps them private from HR roles',async()=>{
  const provider=fake();await expect(requestPasswordReset({email:'known@example.test'},provider)).resolves.toBeUndefined();await expect(requestPasswordReset({email:'unknown@example.test'},provider)).resolves.toBeUndefined();
  expect(provider.sendPasswordReset).not.toHaveBeenCalled();const all=await jobs();expect(all).toHaveLength(2);
  expect(all.every(job=>job.kind==='recovery'&&job.tenantId==='00000000-0000-0000-0000-000000000000'&&job.status==='failed'&&job.lastError==='relayUnavailable'&&job.startedAt===null)).toBe(true);
  expect(await readAccountEmailDeliveries(adminCtx(b))).toEqual([]);
  expect(await withTenant(adminCtx(b),tx=>tx.select().from(s.accountEmailDelivery))).toEqual([]);
  expect(await withTenant({...adminCtx(b),tenantId:'00000000-0000-0000-0000-000000000000'},tx=>tx.select().from(s.accountEmailDelivery))).toEqual([]);
  const actor=await operator();expect(await readAccountEmailDeliveries(adminCtx(b),actor)).toHaveLength(2);
  await owner.db.update(s.deploymentIdentityOperator).set({revokedAt:new Date()});expect(await readAccountEmailDeliveries(adminCtx(b),actor)).toEqual([]);
 });
 it('allows an exact installation operator to retry one recovery request after SMTP is ready, with no automatic replay',async()=>{
  const provider=fake(),ctx=adminCtx(b),actor=await operator();await requestPasswordReset({email:'selected@example.test'},provider);await requestPasswordReset({email:'unselected@example.test'},provider);
  const original=(await jobs()).find(job=>job.recoveryEmail==='selected@example.test')!;
  provider.emailReadiness.mockResolvedValue(null);await readAccountEmailDeliveries(ctx,actor);expect(provider.sendPasswordReset).not.toHaveBeenCalled();
  await expect(retryAccountEmail(ctx,original.id,true,undefined,provider)).rejects.toThrow();
  const results=await Promise.allSettled([retryAccountEmail(ctx,original.id,true,actor,provider),retryAccountEmail(ctx,original.id,true,actor,provider)]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(provider.sendPasswordReset).toHaveBeenCalledOnce();expect(provider.sendPasswordReset).toHaveBeenCalledWith('selected@example.test');
  const all=await jobs();expect(all.find(job=>job.replacesDeliveryId===original.id)).toMatchObject({status:'sent',lastError:null,attempts:1});
  expect(all.find(job=>job.recoveryEmail==='unselected@example.test')).toMatchObject({status:'failed',lastError:'relayUnavailable'});
  expect((await readAccountEmailDeliveries(ctx,actor)).find(job=>job.id===original.id)?.canRetry).toBe(false);
 });
 it('holds uncertain provider failures without exposing raw errors or pretending the request failed',async()=>{
  const provider=fake();provider.emailReadiness.mockResolvedValue(null);provider.sendInvitation.mockRejectedValue(Error('smtp-password-canary'));provider.sendPasswordReset.mockRejectedValue(Error('reset-link-canary'));
  await expect(inviteUser(adminCtx(b),{email:'invite@example.test',role:'employee'},provider)).resolves.toHaveProperty('invitationId');
  await expect(requestPasswordReset({email:'recovery@example.test'},provider)).resolves.toBeUndefined();
  expect((await jobs()).every(job=>job.status==='failed'&&job.lastError==='uncertain'&&job.startedAt!==null)).toBe(true);
  const history=JSON.stringify(await owner.db.select().from(s.domainEvent));expect(history).not.toContain('smtp-password-canary');expect(history).not.toContain('reset-link-canary');
 });
 it('requires the private lease, prevents double starts, and normalizes abandoned requests without resending',async()=>{
  const actor=await operator(),[reserved]=await client<{id:string;lease_token:string}[]>`select * from app.account_email_request_recovery('lease@example.test')`;
  expect(await client`select * from app.account_email_target(${reserved.id}::uuid,${randomUUID()}::uuid,null)`).toEqual([]);
  expect(await client`select * from app.account_email_target(${reserved.id}::uuid,${reserved.lease_token}::uuid,null)`).toMatchObject([{kind:'recovery',email:'lease@example.test'}]);
  const starts=await Promise.all([client`select app.account_email_start(${reserved.id}::uuid,${reserved.lease_token}::uuid,null) as started`,client`select app.account_email_start(${reserved.id}::uuid,${reserved.lease_token}::uuid,null) as started`]);expect(starts.filter(rows=>rows[0].started)).toHaveLength(1);
  expect((await client`select app.account_email_finish(${reserved.id}::uuid,${reserved.lease_token}::uuid,'skipped','notEligible') as changed`)[0].changed).toBe(false);
  await owner.db.update(s.accountEmailDelivery).set({leaseUntil:new Date(Date.now()-1000)}).where(eq(s.accountEmailDelivery.id,reserved.id));
  expect((await readAccountEmailDeliveries(adminCtx(b),actor))[0]).toMatchObject({status:'failed',error:'uncertain',attempts:1});
  expect((await client`select app.account_email_finish(${reserved.id}::uuid,${reserved.lease_token}::uuid,'sent',null) as changed`)[0].changed).toBe(false);
 });
 it('bounds public recovery requests independently of account existence and rejects header injection',async()=>{
  const provider=fake();for(let i=0;i<7;i++)await requestPasswordReset({email:'limited@example.test'},provider);
  expect(await jobs()).toHaveLength(5);await requestPasswordReset({email:'bad@example.test\r\nBcc: attacker@example.test'},provider);expect(await jobs()).toHaveLength(5);expect(provider.sendPasswordReset).not.toHaveBeenCalled();
 });
 it('revokes broad table mutations and public execution on the new privileged helpers',async()=>{
  const [privileges]=await owner.client`select has_table_privilege('ai_hr_app','account_email_delivery','UPDATE') as can_update,has_table_privilege('ai_hr_app','account_email_delivery','DELETE') as can_delete,has_function_privilege('ai_hr_app','app.account_email_operator(text,text)','EXECUTE') as operator_helper`;
  expect(privileges).toMatchObject({can_update:false,can_delete:false,operator_helper:false});
  await expect(withTenant(adminCtx(b),tx=>tx.update(s.accountEmailDelivery).set({lastError:'arbitrary'}))).rejects.toMatchObject({cause:expect.objectContaining({code:'42501'})});
 });
});
