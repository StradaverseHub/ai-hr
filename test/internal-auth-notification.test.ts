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
import {saveLetterEmailPreferences} from '../core/letter-email-preferences';
import {projectLetterNotificationsFromSweep} from '../core/letter-notifications';
import {deliverLetterEmailsFromSweep} from '../core/letter-email-delivery';
import {saveLetterField,saveLetterTemplate,decideLetterTemplate,saveLetterPolicy,createLetterDraftBatch,submitLetterBatch,getLetterGenerationBatch} from '../core/letters';
import type {LetterPolicy} from '../lib/letter-workflow';
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

it('delivers an account-only Letter through the actual internal credential, summary and nonce wrappers',async()=>{
 const author=adminCtx(base),[person]=await owner.db.insert(schema.person).values({tenantId:base.tenantId,fullName:'Fictional account-only signatory',primaryEmail:'internal-letter@fixture.test'}).returning();
 const userId=await createManualAccount(author,{id:randomUUID(),personId:person.id,username:'letter.signer',email:'internal-letter@fixture.test',role:'hr_admin',companyId:null,password:temporary,ownershipAttested:true});
 const login=await startLogin({organization:'alpha',username:'letter.signer',password:temporary,native:false});if(login.step!=='password')throw Error('Expected password change');const setup=await changeInitialPassword(login.challenge,password);if(setup.step!=='enroll'||!setup.secret)throw Error('Expected MFA setup');await verifyMfa(setup.challenge,await generate({secret:setup.secret}));
 const credential=(await credentialByLogin('alpha','letter.signer'))!,signer:SessionContext={tenantId:base.tenantId,userId,personId:person.id,roles:['hr_admin'],entitlements:harnessSnapshot(base.tenantId)};
 await saveNotificationEmailPolicy(author,['letters']);await saveLetterEmailPreferences(signer,{enabled:true,locale:'en'},{issuer:credential.issuer,subject:credential.subject,email:credential.email,emailVerified:true});await writeRecord(client,'email-state',{active:{config:{host:'smtp.invalid'}},revision:'letters-fixture',drafts:{}},null);
 const send=vi.fn(async()=>{}),transport:NotificationEmailTransport=async<T>(request:Parameters<NotificationEmailTransport>[0])=>internalNotificationEmailRequest<T>(request,send);expect(await transport({op:'status'})).toMatchObject({ready:true,letters:true});
 const hired=await hireEmployee(author,{person:{fullName:'Fictional letter subject',primaryEmail:'letter-subject@fixture.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const field=await saveLetterField(author,{companyId:base.companyId,definition:{key:'employeeName',label:'Employee name',description:'Canonical name',kind:'text',source:'employee.name',required:true,editable:false,sensitive:false},active:true});const template=await saveLetterTemplate(author,{companyId:base.companyId,code:'INTERNAL-MAIL',name:'Internal auth mail fixture',category:'confirmation',effectiveFrom:todayInKualaLumpur(),document:{version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'text',text:'PRIVATE LETTER FOR INTERNAL AUTH '},{type:'field',key:'employeeName'}]}]},fieldVersionIds:[field.id]});
 await decideLetterTemplate(author,{versionId:template.versionId,expectedStatus:'draft',action:'submit'});await decideLetterTemplate(signer,{versionId:template.versionId,expectedStatus:'submitted',action:'approve'});
 const policy:LetterPolicy={version:1,stages:[{key:'signatory',label:'Authorised signatory',userIds:[userId],allowDelegation:false}],signatoryUserId:userId,signingMode:'authenticated',signatureAssetId:null,letterheadAssetId:null,referenceFormat:'HR/{YYYY}/{SEQ:6}',retentionDays:365,sensitiveLinkMinutes:15,acknowledgement:'acknowledge',approvalDueHours:48,acknowledgementDueDays:7,reminderHours:24,escalationUserId:null,portalNotifications:false,emailNotifications:true};await saveLetterPolicy(author,{companyId:base.companyId,category:'confirmation',enabled:true,policy});
 const made=await createLetterDraftBatch(author,{companyId:base.companyId,templateVersionId:template.versionId,employmentIds:[hired.employmentId],operationKey:randomUUID()});await submitLetterBatch(author,made.batchId);const row=(await getLetterGenerationBatch(author,made.batchId))!.rows[0];
 const system={tenantId:base.tenantId,roles:[]};expect(await projectLetterNotificationsFromSweep(system,owner)).toMatchObject({created:0,failed:0});expect(await deliverLetterEmailsFromSweep(system,owner,transport)).toMatchObject({attempted:1,failed:0,unavailable:false});expect(send).toHaveBeenCalledOnce();const message=send.mock.calls[0] as unknown as [unknown,{to:string;text:string}];expect(message[1].to).toBe(credential.email);expect(message[1].text).toContain('https://hr.test/letters/approval/'+row.record.id);expect(message[1].text).not.toContain('PRIVATE LETTER FOR INTERNAL AUTH');expect((await owner.client`select status from notification_delivery where tenant_id=${base.tenantId}::uuid and category='letters'`)[0].status).toBe('sent');
});
