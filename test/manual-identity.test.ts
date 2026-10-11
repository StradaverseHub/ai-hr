import {randomUUID} from 'node:crypto';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant,client,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {hireEmployee} from '../core/org';
import {createManualAccount,resumeManualAccount,cancelManualAccount,listManualIdentityEnrollments,type CreateManualAccountInput} from '../core/manual-identity';
import {inviteUser,acceptInvitation,type AuthProvider} from '../core/auth';
import type {ManualAccountProvider} from '../lib/identity/manual-provider';
import {todayInKualaLumpur} from '../lib/hr-date';

const issuer='https://hr.test/identity/realms/ai-hr',password='Private-temporary-password-827';
let base:Base,ctx:SessionContext,input:CreateManualAccountInput;
const subject=randomUUID();
beforeAll(migrateTestDb);
beforeEach(async()=>{
 await resetDb();base=await seedBase();ctx=adminCtx(base);
 await owner.db.insert(schema.appExternalIdentity).values({issuer,subject:'admin',appUserId:base.adminUserId});
 for(const [k,v]of Object.entries({AUTH_PROVIDER:'keycloak',AUTH_PUBLIC_ORIGIN:'https://hr.test',KEYCLOAK_ISSUER:issuer,
  KEYCLOAK_WEB_CLIENT_ID:'web',KEYCLOAK_WEB_CLIENT_SECRET:'secret',KEYCLOAK_MOBILE_CLIENT_ID:'mobile',KEYCLOAK_API_AUDIENCE:'api',AUTH_SESSION_KEY:'f'.repeat(64)}))vi.stubEnv(k,v);
 const employee=await hireEmployee(ctx,{person:{fullName:'Manual Enrollment',primaryEmail:'manual@example.test'},companyId:base.companyId,
 departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 input={id:randomUUID(),personId:employee.personId,username:'Manual.Login',email:'manual@example.test',role:'employee',companyId:null,password,ownershipAttested:true};
});
afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);
function fake(){return {create:vi.fn<ManualAccountProvider['create']>(async()=>subject),setPassword:vi.fn<ManualAccountProvider['setPassword']>(async()=>{}),
 enable:vi.fn<ManualAccountProvider['enable']>(async e=>{
  // Independent connection proves the exact HR binding committed BEFORE provider activation.
  const [p]=await client`select * from app.principal_by_identity(${issuer},${e.subject})`;
  expect(p.app_user_id).toBe(e.app_user_id);expect(p.person_id).toBe(input.personId);
 }),cancel:vi.fn<ManualAccountProvider['cancel']>(async()=>{})};}
async function intent(){return (await owner.client`select * from app_manual_identity_enrollment where id=${input.id}::uuid`)[0];}
async function call(ctxOverride:SessionContext,expression:ReturnType<typeof sql>){return withTenant(ctxOverride,tx=>tx.execute(expression));}

describe('manual account enrollment — actual app role and tenant guards',()=>{
 it('commits one exact subject/person/grants binding, no email, and never persists or resets a completed password',async()=>{
  const p=fake();const user=await createManualAccount(ctx,input,p);
  expect((await intent()).status).toBe('active');expect((await intent()).username).toBe('manual.login');
  expect(p.setPassword).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({status:'prepared',subject}),password);
  expect(await resumeManualAccount(ctx,input.id,'Different-password-after-success',p)).toBe(user);
  expect(await createManualAccount(ctx,{...input,password:'Yet-another-temporary-password'},p)).toBe(user);
  expect(p.create).toHaveBeenCalledTimes(1);expect(p.setPassword).toHaveBeenCalledTimes(1);expect(p.enable).toHaveBeenCalledTimes(1);
  const events=await owner.client`select event_type,payload from domain_event where event_type like 'app-user.manual-enrollment-%' order by occurred_at,id`;
  expect(events).toHaveLength(4);expect(JSON.stringify(events)).not.toContain(password);
  expect(JSON.stringify(await owner.client`select row_to_json(e) data from app_manual_identity_enrollment e`)).not.toContain(password);
  expect(await owner.db.select().from(schema.appInvitation)).toHaveLength(0);
 });
 it('resumes a known disabled subject after password failure and a committed binding after activation failure',async()=>{
  const p=fake();p.setPassword.mockRejectedValueOnce(new Error(password));
  await expect(createManualAccount(ctx,input,p)).rejects.toMatchObject({code:'unavailable'});
  expect((await intent()).status).toBe('prepared');expect((await intent()).subject).toBe(subject);
  p.enable.mockRejectedValueOnce(new Error('offline'));
  await expect(resumeManualAccount(ctx,input.id,password,p)).rejects.toMatchObject({code:'unavailable'});
  expect((await intent()).status).toBe('linked');const resets=p.setPassword.mock.calls.length;
  await resumeManualAccount(ctx,input.id,'',p);expect((await intent()).status).toBe('active');
  expect(p.create).toHaveBeenCalledTimes(1);expect(p.setPassword).toHaveBeenCalledTimes(resets);
 });
 it('two concurrent submissions create and activate once',async()=>{
  const p=fake();const results=await Promise.allSettled([createManualAccount(ctx,input,p),createManualAccount(ctx,input,p)]);
  expect(results.every(r=>r.status==='fulfilled')).toBe(true);expect(results[0]).toEqual(results[1]);expect(p.create).toHaveBeenCalledTimes(1);expect(p.setPassword).toHaveBeenCalledTimes(1);expect(p.enable).toHaveBeenCalledTimes(1);
 });
 it('rejects employees, delegated admins and stale/revoked group grants before touching the provider, including direct SQL',async()=>{
  const p=fake();
  await owner.db.update(schema.roleAssignment).set({companyId:base.companyId}).where(eq(schema.roleAssignment.appUserId,base.adminUserId));
  await expect(createManualAccount(ctx,input,p)).rejects.toMatchObject({code:'forbidden'});
  await expect(call(ctx,sql`select * from app.manual_identity_reserve(${input.id}::uuid,${issuer},${input.personId}::uuid,'manual.login',${input.email},'employee',null)`)).rejects.toThrow();
  expect(p.create).not.toHaveBeenCalled();
 });
 it('refuses another tenant person/company, forbidden roles, weak passwords and absent ownership attestation',async()=>{
  const other=await seedBase(),p=fake();
  const [foreignPerson]=await owner.db.insert(schema.person).values({tenantId:other.tenantId,fullName:'Foreign target',primaryEmail:'foreign@example.test'}).returning();
  for(const change of [{personId:foreignPerson.id},{companyId:other.companyId},{role:'operator'},{role:'super_admin',companyId:base.companyId},{password:'short'},{ownershipAttested:false}]){
   await expect(createManualAccount(ctx,{...input,...change},p)).rejects.toBeDefined();
  }
  expect(p.create).not.toHaveBeenCalled();
  await expect(call(ctx,sql`select * from app.manual_identity_reserve(${input.id}::uuid,${issuer},${input.personId}::uuid,'manual.login',${input.email},'operator',null)`)).rejects.toThrow();
 });
 it('cannot adopt real, archived, revoked or higher-authority placeholder logins',async()=>{
  const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,personId:input.personId,workosUserId:'real-login'}).returning();const p=fake();
  await expect(createManualAccount(ctx,input,p)).rejects.toMatchObject({code:'conflict'});
  await owner.db.update(schema.appUser).set({workosUserId:'seed:pending',archivedAt:new Date()}).where(eq(schema.appUser.id,user.id));
  await expect(createManualAccount(ctx,input,p)).rejects.toMatchObject({code:'conflict'});
  await owner.db.update(schema.appUser).set({archivedAt:null}).where(eq(schema.appUser.id,user.id));
  await owner.db.insert(schema.appExternalIdentity).values({issuer,subject:'revoked',appUserId:user.id,revokedAt:new Date()});
  await expect(createManualAccount(ctx,input,p)).rejects.toMatchObject({code:'conflict'});
  await owner.db.delete(schema.appExternalIdentity).where(eq(schema.appExternalIdentity.appUserId,user.id));
  await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,role:'hr_admin',companyId:null});
  await expect(createManualAccount(ctx,input,p)).rejects.toMatchObject({code:'conflict'});expect(p.create).not.toHaveBeenCalled();
 });
 it('preserves a legitimate unactivated placeholder user and refuses an identity already enrolled elsewhere',async()=>{
  const [user]=await owner.db.insert(schema.appUser).values({tenantId:base.tenantId,personId:input.personId,workosUserId:'seed:pending'}).returning();
  await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:user.id,role:'employee',companyId:null});
  const p=fake();p.create.mockResolvedValueOnce('admin');
  await expect(createManualAccount(ctx,input,p)).rejects.toMatchObject({code:'conflict'});
  // The prepared exact ID is immutable; cancellation removes only the disabled provider identity
  // associated with this setup. A real provider refuses the already-enabled admin before this point.
  expect((await intent()).status).toBe('reserved');
  p.create.mockResolvedValueOnce(subject);expect(await resumeManualAccount(ctx,input.id,password,p)).toBe(user.id);
  expect(await owner.db.select().from(schema.roleAssignment).where(eq(schema.roleAssignment.appUserId,user.id))).toHaveLength(1);
 });
 it('cancels only unlinked setup and keeps exact incomplete state when provider deletion is uncertain',async()=>{
  const p=fake();p.setPassword.mockRejectedValue(new Error('offline'));
  await expect(createManualAccount(ctx,input,p)).rejects.toBeDefined();
  p.cancel.mockRejectedValueOnce(new Error('offline'));
  await expect(cancelManualAccount(ctx,input.id,p)).rejects.toBeDefined();expect((await intent()).status).toBe('prepared');
  await cancelManualAccount(ctx,input.id,p);expect((await intent()).status).toBe('cancelled');
  expect(await listManualIdentityEnrollments(ctx)).toHaveLength(0);
  await expect(resumeManualAccount(ctx,input.id,password,p)).rejects.toMatchObject({code:'conflict'});
 });
 it('does not enable a linked account that has since been archived or rebound',async()=>{
  const p=fake();p.enable.mockRejectedValueOnce(new Error('offline'));
  await expect(createManualAccount(ctx,input,p)).rejects.toBeDefined();
  const row=await intent();await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,row.app_user_id));
  await expect(resumeManualAccount(ctx,input.id,'',p)).rejects.toMatchObject({code:'conflict'});expect(p.enable).toHaveBeenCalledTimes(1);
 });
 it('refuses mailed enrollment that would replace an already manually enrolled person',async()=>{
  const p=fake();await createManualAccount(ctx,input,p);
  const emailProvider:AuthProvider={sendInvitation:async()=>({invitationId:'fake'}),revokeInvitation:async()=>{},sendPasswordReset:async()=>{},endSession:async()=>{}};
  const {token}=await inviteUser(ctx,{personId:input.personId,email:input.email,role:'employee'},emailProvider);
  await expect(acceptInvitation({token,issuer,subject:'different',verifiedEmail:input.email})).rejects.toThrow();
  expect(await owner.db.select().from(schema.appUser).where(eq(schema.appUser.personId,input.personId))).toHaveLength(1);
 });
 it('private state cannot be read, updated or forged by the application role and another tenant cannot resume it',async()=>{
  const p=fake();p.create.mockRejectedValue(new Error('offline'));await expect(createManualAccount(ctx,{...input,companyId:base.companyId},p)).rejects.toBeDefined();
  expect((await call(ctx,sql`select app.manual_identity_company_in_use(${base.companyId}::uuid) used`))[0].used).toBe(true);
  expect((await call({...ctx,roles:['employee'],grants:[{role:'employee',companyId:null}]},sql`select app.manual_identity_company_in_use(${base.companyId}::uuid) used`))[0].used).toBe(false);
  await expect(client`select * from app_manual_identity_enrollment`).rejects.toThrow(/permission denied/);
  await expect(call(ctx,sql`update app_manual_identity_enrollment set status='active'`)).rejects.toThrow();
  const other=await seedBase();await owner.db.insert(schema.appExternalIdentity).values({issuer,subject:'other-admin',appUserId:other.adminUserId});
  await expect(resumeManualAccount(adminCtx(other),input.id,password,p)).rejects.toMatchObject({code:'forbidden'});
  expect((await call(adminCtx(other),sql`select app.manual_identity_company_in_use(${base.companyId}::uuid) used`))[0].used).toBe(false);
  const [grants]=await owner.client`select has_function_privilege('ai_hr_app','app.manual_identity_target(uuid,text,uuid)','EXECUTE') allowed`;
  expect(grants.allowed).toBe(false);
 });
});
