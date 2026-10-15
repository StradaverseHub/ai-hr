import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { generate } from 'otplib';
import { adminCtx, closeAll, harnessSnapshot, migrateTestDb, owner, resetDb, seedBase, setModule, type Base } from './harness';
import { client, type SessionContext } from '../db/client';
import { bootstrapInternalOwner } from '../lib/internal-auth/bootstrap';
import { changeInitialPassword, credentialByLogin, startLogin, verifyMfa } from '../lib/internal-auth/service';
import { writeRecord } from '../lib/internal-auth/store';
import { internalNotificationEmailRequest } from '../lib/internal-auth/notification-mail';
import { hireEmployee } from '../core/org';
import { createManualAccount } from '../core/manual-identity';
import { dispatchNotifications } from '../core/notifications';
import { deliverNotificationEmails, type NotificationEmailTransport } from '../core/notification-email-delivery';
import { retryNotificationEmail, saveNotificationEmailPolicy, saveNotificationEmailPreferences } from '../core/notification-email';
import { todayInKualaLumpur } from '../lib/hr-date';
import * as schema from '../db/schema';
let base:Base;
const temporary='A synthetic private passphrase 771!',password='A different synthetic passphrase 883!';
beforeAll(migrateTestDb);beforeEach(async()=>{
 await resetDb();base=await seedBase();await setModule(base.tenantId,'notifications','active');
 vi.stubEnv('AUTH_PROVIDER','internal');vi.stubEnv('AUTH_PUBLIC_ORIGIN','https://hr.test');vi.stubEnv('AUTH_SESSION_KEY','7'.repeat(64));
 await bootstrapInternalOwner(owner.client,{appUserId:base.adminUserId,organization:'alpha',username:'owner',email:'owner@example.test',password:temporary,installationOperator:true});
});afterEach(()=>vi.unstubAllEnvs());afterAll(closeAll);
it('uses the internal credential and shared consent/lease rules, holds missing-SMTP failures and skips a disabled recipient',async()=>{
 const employee=await hireEmployee(adminCtx(base),{person:{fullName:'Notification Fixture',primaryEmail:'notify@example.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const userId=await createManualAccount(adminCtx(base),{id:randomUUID(),personId:employee.personId,username:'mail.user',email:'notify@example.test',role:'employee',companyId:null,password:temporary,ownershipAttested:true});
 const login=await startLogin({organization:'alpha',username:'mail.user',password:temporary,native:false});if(login.step!=='password')throw Error('Expected password change');
 const setup=await changeInitialPassword(login.challenge,password);if(setup.step!=='enroll'||!setup.secret)throw Error('Expected MFA setup');
 await verifyMfa(setup.challenge,await generate({secret:setup.secret}));
 const c=(await credentialByLogin('alpha','mail.user'))!,ctx:SessionContext={tenantId:base.tenantId,userId,personId:employee.personId,roles:['employee'],entitlements:harnessSnapshot(base.tenantId)};
 await saveNotificationEmailPolicy(adminCtx(base),['leave']);await saveNotificationEmailPreferences(ctx,employee.employmentId,['leave'],'en',{issuer:c.issuer,subject:c.subject,email:c.email,emailVerified:true});
 const event=()=>owner.db.insert(schema.domainEvent).values({tenantId:base.tenantId,aggregateType:'test',aggregateId:randomUUID(),eventType:'leave-request.approved',actorType:'system',subjectEmploymentId:employee.employmentId,payload:{privateCanary:'PRIVATE-PAY-FIXTURE-993'}});
 await event();await dispatchNotifications(adminCtx(base));
 expect(await deliverNotificationEmails(adminCtx(base))).toMatchObject({attempted:1,unavailable:true});
 const jobs=await owner.client`select id,status,last_error from notification_delivery where tenant_id=${base.tenantId}::uuid and channel='email' order by created_at,id`;
 expect(jobs).toHaveLength(1);expect(jobs[0]).toMatchObject({status:'failed',last_error:'relayUnavailable'});
 await writeRecord(client,'email-state',{active:{config:{host:'smtp.invalid'}},revision:'fixture',drafts:{}},null);
 const send=vi.fn(async()=>{}),failures:string[]=[];
 const transport:NotificationEmailTransport=async <T>(request:Parameters<NotificationEmailTransport>[0])=>{
  try{return await internalNotificationEmailRequest<T>(request,send);}
  catch(error){failures.push(error instanceof Error?error.message:String(error));throw error;}
 };
 expect(await deliverNotificationEmails(adminCtx(base),transport)).toMatchObject({attempted:0});expect(send).not.toHaveBeenCalled();
 await retryNotificationEmail(adminCtx(base),jobs[0].id,true);
 expect(await deliverNotificationEmails(adminCtx(base),transport)).toMatchObject({attempted:1});
 expect(failures).toEqual([]);
 expect(await owner.client`select status,last_error from notification_delivery where id=${jobs[0].id}::uuid`).toEqual([{status:'sent',last_error:null}]);
 expect(send).toHaveBeenCalledOnce();
 const message=send.mock.calls[0] as unknown as [unknown,{to:string;text:string}];expect(message[1].to).toBe(c.email);expect(message[1].text).toContain('https://hr.test/');expect(message[1].text).not.toContain('PRIVATE-PAY-FIXTURE-993');
 await event();await dispatchNotifications(adminCtx(base));await writeRecord(client,`credential:${c.subject}`,{...c,enabled:false},c.subject);
 expect(await deliverNotificationEmails(adminCtx(base),transport)).toMatchObject({attempted:1});expect(send).toHaveBeenCalledOnce();
 const skipped=await owner.client`select status,last_error from notification_delivery where tenant_id=${base.tenantId}::uuid and status='skipped' order by created_at,id`;
 expect(skipped).toEqual([{status:'skipped',last_error:'recipientChanged'}]);
});
