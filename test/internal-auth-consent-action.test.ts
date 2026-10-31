/** Real action/provider/core/SQL integration. Programmatic password/MFA setup is fictional fixture
 * evidence only; it does not establish human login/MFA or browser acceptance. No SMTP is configured.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { generate } from 'otplib';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const boundary=vi.hoisted(()=>({session:vi.fn(),identity:vi.fn()}));
vi.mock('../core/letter-email-preferences',()=>({saveLetterEmailPreferences:vi.fn()}));
vi.mock('../lib/session',()=>({getSession:boundary.session}));
vi.mock('../lib/internal-auth/web-session',()=>({currentInternalIdentity:boundary.identity}));
vi.mock('next/cache',()=>({revalidatePath:vi.fn()}));
vi.mock('next/navigation',()=>({redirect:(path:string)=>{throw new Error('REDIRECT '+path);}}));
import { adminCtx, closeAll, harnessSnapshot, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { client, type SessionContext } from '../db/client';
import { bootstrapInternalOwner } from '../lib/internal-auth/bootstrap';
import { changeInitialPassword, readSession, startLogin, verifyMfa } from '../lib/internal-auth/service';
import { createManualAccount } from '../core/manual-identity';
import { hireEmployee } from '../core/org';
import { dispatchNotifications } from '../core/notifications';
import { saveNotificationEmailPolicy } from '../core/notification-email';
import { saveMyWorkflowEmailPreferences } from '../app/(app)/me/notifications/actions';
import { todayInKualaLumpur } from '../lib/hr-date';
import * as schema from '../db/schema';

const origin='https://consent-action.test';
const temporary='A synthetic private passphrase 771!',password='A different synthetic passphrase 883!';
let base:Base,actor:Awaited<ReturnType<typeof enrolledEmployee>>;

async function enrolledEmployee(username:string,email:string) {
  const employee=await hireEmployee(adminCtx(base),{
    person:{fullName:'Fictional consent action '+username,primaryEmail:email},companyId:base.companyId,
    departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur(),
  });
  const userId=await createManualAccount(adminCtx(base),{
    id:randomUUID(),personId:employee.personId,username,email,role:'employee',companyId:null,
    password:temporary,ownershipAttested:true,
  });
  const initial=await startLogin({organization:'consent-action',username,password:temporary,native:false});
  if(initial.step!=='password')throw Error('Fixture expected initial password change');
  const setup=await changeInitialPassword(initial.challenge,password);
  if(setup.step!=='enroll'||!setup.secret)throw Error('Fixture expected authenticator enrollment');
  const completed=await verifyMfa(setup.challenge,await generate({secret:setup.secret}));
  if(completed.step!=='complete')throw Error('Fixture expected completed authentication');
  const ctx:SessionContext={tenantId:base.tenantId,userId,personId:employee.personId,
    roles:['employee'],entitlements:harnessSnapshot(base.tenantId)};
  return {...employee,userId,ctx,token:completed.access_token};
}

// Replace only cookie acquisition: the identity still comes from the real encrypted session reader,
// including current credential version, MFA completion and exact active principal checks.
async function sessionIdentity(token:string) {
  const current=await readSession(token);
  if(!current)return null;
  const {issuer,subject,email,emailVerified}=current;
  return {issuer,subject,email,emailVerified};
}
function preferenceForm(employmentId=actor.employmentId,enabled=true) {
  const form=new FormData();form.set('employmentId',employmentId);form.set('locale','ms');
  if(enabled)form.append('category','leave');
  return form;
}
const preferences=()=>owner.db.select().from(schema.notificationPref)
  .where(and(eq(schema.notificationPref.tenantId,base.tenantId),eq(schema.notificationPref.channel,'email')))
  .orderBy(schema.notificationPref.recipientEmploymentId,schema.notificationPref.category);
const deliveries=()=>owner.db.select().from(schema.notificationDelivery)
  .where(and(eq(schema.notificationDelivery.tenantId,base.tenantId),eq(schema.notificationDelivery.channel,'email')))
  .orderBy(schema.notificationDelivery.createdAt,schema.notificationDelivery.id);
const policy=()=>owner.db.select().from(schema.notificationEmailPolicy)
  .where(eq(schema.notificationEmailPolicy.tenantId,base.tenantId)).orderBy(schema.notificationEmailPolicy.category);
async function leaveEvent(employmentId=actor.employmentId) {
  const [event]=await owner.db.insert(schema.domainEvent).values({tenantId:base.tenantId,
    aggregateType:'test',aggregateId:randomUUID(),eventType:'leave-request.approved',actorType:'system',
    subjectEmploymentId:employmentId,payload:{fixture:'internal-consent-action'},
  }).returning();
  return event;
}

beforeAll(migrateTestDb);
beforeEach(async()=>{
  vi.clearAllMocks();await resetDb();base=await seedBase();await setModule(base.tenantId,'notifications','active');
  vi.stubEnv('AUTH_PROVIDER','internal');vi.stubEnv('AUTH_PUBLIC_ORIGIN',origin);vi.stubEnv('AUTH_SESSION_KEY','7'.repeat(64));
  await bootstrapInternalOwner(owner.client,{appUserId:base.adminUserId,organization:'consent-action',
    username:'owner',email:'owner@example.test',password:temporary,installationOperator:true});
  actor=await enrolledEmployee('consent.user','consent@example.test');
  boundary.session.mockResolvedValue(actor.ctx);
  boundary.identity.mockImplementation(()=>sessionIdentity(actor.token));
  await saveNotificationEmailPolicy(adminCtx(base),['leave']);
});
afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);

describe('internal consent action with canonical persisted bindings',()=>{
  it('adds only the authenticated account consent and excludes old events without losing later events on save',async()=>{
    const old=await leaveEvent(),form=preferenceForm();
    for(const [key,value]of Object.entries({issuer:'https://evil.test',subject:randomUUID(),email:'attacker@example.test',emailVerified:'true',userId:randomUUID()}))form.set(key,value);
    await expect(saveMyWorkflowEmailPreferences(form)).rejects.toThrow('REDIRECT /me/notifications?saved=1');
    expect(boundary.identity).toHaveBeenCalledOnce();
    const consent=(await preferences()).find(row=>row.category==='leave');
    expect(consent).toMatchObject({recipientEmploymentId:actor.employmentId,enabled:true,emailConsentUserId:actor.userId,emailLocale:'ms'});
    expect(consent?.emailAfterSequence).not.toBeNull();
    expect(consent!.emailAfterSequence!).toBeGreaterThanOrEqual(Number(old.sequence));
    const future=await leaveEvent();
    await expect(saveMyWorkflowEmailPreferences(preferenceForm())).rejects.toThrow('saved=1');
    expect((await preferences()).find(row=>row.category==='leave')?.emailAfterSequence).toBe(consent!.emailAfterSequence);
    await dispatchNotifications(adminCtx(base));
    expect((await deliveries()).map(row=>({event:row.sourceEventId,user:row.recipientUserId})))
      .toEqual([{event:future.id,user:actor.userId}]);
    const inApp=await owner.db.select({event:schema.notification.sourceEventId}).from(schema.notification)
      .where(and(eq(schema.notification.tenantId,base.tenantId),eq(schema.notification.kind,'leave.approved')));
    expect(inApp.map(row=>row.event).sort()).toEqual([old.id,future.id].sort());
  });

  it('refuses another person employment even with the same email and forged form identity',async()=>{
    const other=await hireEmployee(adminCtx(base),{person:{fullName:'Other fictional person',primaryEmail:'consent@example.test'},
      companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
    const form=preferenceForm(other.employmentId);form.set('email','consent@example.test');form.set('emailVerified','true');form.set('personId',other.personId);
    await expect(saveMyWorkflowEmailPreferences(form)).rejects.toThrow('REDIRECT /me/notifications?error=save');
    expect(await preferences()).toEqual([]);expect(await deliveries()).toEqual([]);
  });

  it('refuses a different real verified identity sharing the email instead of adopting its binding',async()=>{
    const other=await enrolledEmployee('other.consent','consent@example.test');
    boundary.identity.mockImplementation(()=>sessionIdentity(other.token));
    await expect(saveMyWorkflowEmailPreferences(preferenceForm())).rejects.toThrow('REDIRECT /me/notifications?error=save');
    expect(await preferences()).toEqual([]);
  });

  it('refuses unverified provider proof despite verified form claims',async()=>{
    const identity=await sessionIdentity(actor.token);expect(identity).not.toBeNull();
    // Lower-adapter negative control only; no credential/private SQL is mocked or overwritten.
    boundary.identity.mockResolvedValue({...identity!,emailVerified:false});
    const form=preferenceForm();form.set('issuer',identity!.issuer);form.set('subject',identity!.subject);form.set('emailVerified','true');
    await expect(saveMyWorkflowEmailPreferences(form)).rejects.toThrow('REDIRECT /me/notifications?error=save');
    expect(await preferences()).toEqual([]);
  });

  it('withdraws with unavailable provider proof, preserves policy and removes pending/future email eligibility',async()=>{
    await expect(saveMyWorkflowEmailPreferences(preferenceForm())).rejects.toThrow('saved=1');
    const beforePolicy=await policy();await leaveEvent();await dispatchNotifications(adminCtx(base));
    const [pending]=await deliveries();expect(pending).toMatchObject({status:'pending',recipientUserId:actor.userId});
    // Only an isolated fixture lease is assigned directly; consent and eligibility use real owners.
    const nonce=randomUUID();await owner.db.update(schema.notificationDelivery)
      .set({leaseToken:nonce,leaseUntil:new Date(Date.now()+30_000)}).where(eq(schema.notificationDelivery.id,pending.id));
    const target=()=>client`select * from app.internal_auth_notification_target(${pending.id}::uuid,${nonce}::uuid,${origin})`;
    expect(await target()).toMatchObject([{user_id:actor.userId,subject:(await sessionIdentity(actor.token))!.subject}]);
    boundary.identity.mockRejectedValue(Error('private provider outage'));
    await expect(saveMyWorkflowEmailPreferences(preferenceForm(actor.employmentId,false))).rejects.toThrow('saved=1');
    expect((await preferences()).filter(row=>row.enabled)).toEqual([]);
    expect((await preferences()).every(row=>row.emailConsentUserId===null&&row.emailAfterSequence===null)).toBe(true);
    expect(await policy()).toEqual(beforePolicy);expect(await target()).toEqual([]);
    await leaveEvent();await dispatchNotifications(adminCtx(base));
    expect((await deliveries()).map(row=>row.id)).toEqual([pending.id]);
    expect((await deliveries())[0]).toMatchObject({status:'pending',attempts:0,startedAt:null});
  });
});
