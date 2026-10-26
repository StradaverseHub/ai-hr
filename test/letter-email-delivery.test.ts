/** Actual database/nonces and an isolated mail role; SMTP/provider ports are injected, not human delivery proof. */
import {randomUUID} from 'node:crypto';
import postgres from 'postgres';
import {afterAll,beforeAll,beforeEach,it,expect,vi} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import * as s from '../db/schema';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {saveLetterField,saveLetterTemplate,decideLetterTemplate,saveLetterPolicy,createLetterDraftBatch,submitLetterBatch,getLetterGenerationBatch,saveLetterPermission} from '../core/letters';
import {saveLetterEmailPreferences} from '../core/letter-email-preferences';
import {saveNotificationEmailPolicy,readNotificationEmailDeliveries,retryNotificationEmail} from '../core/notification-email';
import {projectLetterNotificationsFromSweep} from '../core/letter-notifications';
import {deliverLetterEmailsFromSweep} from '../core/letter-email-delivery';
import {listNotifications} from '../core/notifications';
import {workflowEmailDatabaseGrants} from '../deploy/identity-email/database';
import {createNotificationEmailService,type WorkflowMailTarget,type WorkflowMail} from '../deploy/identity-email/notifications';
import {workflowEmailMessage} from '../deploy/identity-email/notification-message';
import type {NotificationEmailTransport} from '../core/notification-email-delivery';
import type {LetterPolicy} from '../lib/letter-workflow';
import {todayInKualaLumpur} from '../lib/hr-date';
import {closeAll,createAppUser,entitledCtx,owner,resetDb,seedBase,setModule,type Base} from './harness';
const raw=postgres(process.env.TEST_MIGRATION_DATABASE_URL!,{max:3}),role='letter_email_'+randomUUID().replaceAll('-','');
let b:Base,ctx:SessionContext,reviewer:SessionContext,templateVersionId:string,employmentId:string,letterId:string,personId:string,subject:string;
const issuer='https://hr.fixture.test/identity/realms/letters',email='letter-reviewer@fixture.test',canary='PRIVATE LETTER CONTENT 7625';
const identity=()=>({issuer,subject,email,emailVerified:true});
const system=()=>({tenantId:b.tenantId,roles:[]});
const relay:NotificationEmailTransport=async<T>()=>({version:1,ready:true,letters:true}) as T;
function policy():LetterPolicy{return {version:1,stages:[{key:'signatory',label:'Authorised signatory',userIds:[reviewer.userId!],allowDelegation:false}],signatoryUserId:reviewer.userId!,signingMode:'authenticated',signatureAssetId:null,letterheadAssetId:null,referenceFormat:'HR/{YYYY}/{SEQ:6}',retentionDays:365,sensitiveLinkMinutes:15,acknowledgement:'acknowledge',approvalDueHours:48,acknowledgementDueDays:7,reminderHours:24,escalationUserId:null,portalNotifications:false,emailNotifications:true};}
async function draft(){const made=await createLetterDraftBatch(ctx,{companyId:b.companyId,templateVersionId,employmentIds:[employmentId],operationKey:randomUUID()});await submitLetterBatch(ctx,made.batchId);return (await getLetterGenerationBatch(ctx,made.batchId))!.rows[0].record.id;}
const jobs=()=>owner.db.select().from(s.notificationDelivery).where(and(eq(s.notificationDelivery.tenantId,b.tenantId),eq(s.notificationDelivery.category,'letters'))).orderBy(s.notificationDelivery.id);
async function target(id:string,token:string){return raw.begin(async tx=>{await tx.unsafe('SET LOCAL ROLE "'+role+'"');const [scope]=await tx`select current_setting('app.user_id',true) as principal`;expect(scope.principal??'').toBe('');const rows=await tx`select * from identity_email.delivery_target(${id}::uuid,${token}::uuid,${issuer})`;return rows.length===1?rows[0] as WorkflowMailTarget:null;});}
function sender(options:{beforeTarget?:()=>Promise<void>;loseCommit?:boolean;send?:ReturnType<typeof vi.fn>}={}){
 const send=options.send??vi.fn(async(_target:WorkflowMailTarget,_mail:WorkflowMail)=>{});
 const service=createNotificationEmailService({origin:'https://hr.fixture.test',ready:async()=>true,lettersReady:async()=>true,
  target:async(id,token)=>{await options.beforeTarget?.();return await target(id,token) as WorkflowMailTarget|null;},verifyRecipient:async()=> 'verified',
  assessmentTasks:async(id,token)=>raw.begin(async tx=>{await tx.unsafe('SET LOCAL ROLE "'+role+'"');const rows=await tx`select * from identity_email.delivery_summary(${id}::uuid,${token}::uuid,${issuer})`;return rows.length===1&&!rows[0].required?undefined:rows[0]?.summary??null;}),
  start:async(id,token,expected)=>raw.begin(async tx=>{await tx.unsafe('SET LOCAL ROLE "'+role+'"');return (await tx`select identity_email.start_delivery(${id}::uuid,${token}::uuid,${issuer},${tx.json(expected)}::jsonb) as ok`)[0].ok===true;}),
  finish:async(id,token,outcome,error)=>{if(options.loseCommit)throw Error('Fictional result commit outage');return raw.begin(async tx=>{await tx.unsafe('SET LOCAL ROLE "'+role+'"');return (await tx`select identity_email.finish_delivery(${id}::uuid,${token}::uuid,${outcome},${error}) as ok`)[0].ok===true;});},send});
 const transport:NotificationEmailTransport=async<T>(request:Parameters<NotificationEmailTransport>[0])=>await service(request) as T;return {send,transport};
}
beforeAll(async()=>{await raw.unsafe('CREATE ROLE "'+role+'" NOLOGIN');await raw.unsafe('GRANT USAGE ON SCHEMA identity_email TO "'+role+'"');for(const statement of workflowEmailDatabaseGrants(role))await raw.unsafe(statement);});
beforeEach(async()=>{
 vi.stubEnv('AUTH_PROVIDER','workos');vi.stubEnv('NEXT_PUBLIC_WORKOS_REDIRECT_URI','https://hr.fixture.test/callback');await resetDb();b=await seedBase();await setModule(b.tenantId,'notifications','active');ctx=await entitledCtx(b);
 const [person]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional mail signatory',primaryEmail:email}).returning();personId=person.id;const userId=await createAppUser(b.tenantId,personId,'hr_admin');reviewer={...ctx,userId,personId};subject=randomUUID();await owner.db.insert(s.appExternalIdentity).values({issuer,subject,appUserId:userId});
 const hired=await hireEmployee(ctx,{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur(),employeeCode:'LETTER-MAIL-001',person:{fullName:'Fictional mail employee',primaryEmail:'mail-employee@fixture.test'}});employmentId=hired.employmentId;
 const field=await saveLetterField(ctx,{companyId:b.companyId,definition:{key:'employeeName',label:'Employee name',description:'Canonical name',kind:'text',source:'employee.name',required:true,editable:false,sensitive:false},active:true});
 const template=await saveLetterTemplate(ctx,{companyId:b.companyId,code:'MAIL',name:'Fictional letter mail',category:'confirmation',effectiveFrom:todayInKualaLumpur(),document:{version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'text',text:canary},{type:'field',key:'employeeName'}]}]},fieldVersionIds:[field.id]});templateVersionId=template.versionId;
 await decideLetterTemplate(ctx,{versionId:templateVersionId,expectedStatus:'draft',action:'submit'});await decideLetterTemplate(reviewer,{versionId:templateVersionId,expectedStatus:'submitted',action:'approve'});
 await saveNotificationEmailPolicy(ctx,['letters']);await saveLetterEmailPreferences(reviewer,{enabled:true,locale:'ms'},identity());await saveLetterPolicy(ctx,{companyId:b.companyId,category:'confirmation',policy:policy(),enabled:true},{transport:relay});letterId=await draft();
});
afterAll(async()=>{vi.unstubAllEnvs();await raw.unsafe('DROP OWNED BY "'+role+'"');await raw.unsafe('DROP ROLE "'+role+'"');await raw.end();await closeAll();});
it('sends one brief email to an account without employment while keeping email-only rows out of the bell',async()=>{
 expect(await owner.db.select().from(s.employment).where(eq(s.employment.personId,personId))).toHaveLength(0);expect(await projectLetterNotificationsFromSweep(system(),owner)).toMatchObject({created:0,failed:0});expect(await listNotifications(reviewer)).toHaveLength(0);const [notice]=await owner.db.select().from(s.notification).where(eq(s.notification.recipientUserId,reviewer.userId!));expect(notice.portalVisible).toBe(false);expect(await jobs()).toHaveLength(1);
 const {send,transport}=sender();const results=await Promise.all([deliverLetterEmailsFromSweep(system(),owner,transport),deliverLetterEmailsFromSweep(system(),owner,transport)]);expect(results.reduce((sum,result)=>sum+result.attempted,0)).toBe(1);expect(results.every(result=>result.failed===0)).toBe(true);expect(send).toHaveBeenCalledOnce();const [recipient,mail]=send.mock.calls[0] as unknown as [WorkflowMailTarget,WorkflowMail];expect(recipient.email).toBe(email);expect(mail).toMatchObject({category:'letters',locale:'ms',link:'https://hr.fixture.test/letters/approval/'+letterId});expect(workflowEmailMessage(mail).text).not.toContain(canary);expect(workflowEmailMessage(mail).text).not.toContain('Fictional mail employee');expect(Object.keys(mail).sort()).toEqual(['action','category','link','locale','messageId']);
 expect((await jobs())[0]).toMatchObject({status:'sent',attempts:1,lastError:null});expect(await deliverLetterEmailsFromSweep(system(),owner,transport)).toMatchObject({attempted:0});expect(send).toHaveBeenCalledOnce();
});
it('does not replay an old source after withdrawal and re-consent',async()=>{
 await saveLetterEmailPreferences(reviewer,{enabled:false,locale:'en'},null);expect(await projectLetterNotificationsFromSweep(system(),owner)).toMatchObject({failed:0});expect(await jobs()).toHaveLength(0);
 await saveLetterEmailPreferences(reviewer,{enabled:true,locale:'en'},identity());const [notice]=await owner.db.select().from(s.notification).where(eq(s.notification.recipientUserId,reviewer.userId!));const [result]=await owner.withTenant(system(),tx=>tx.execute<{added:boolean}>(sql`select app.letter_email_enqueue(${notice.id}::uuid) as added`));expect(result.added).toBe(false);expect(await jobs()).toHaveLength(0);
 await draft();expect(await projectLetterNotificationsFromSweep(system(),owner)).toMatchObject({failed:0});expect(await jobs()).toHaveLength(1);
});
it.each(['permission','module','consent','address','identity'] as const)('rechecks %s after claiming a nonce and before SMTP',async change=>{
 await projectLetterNotificationsFromSweep(system(),owner);const {send,transport}=sender({beforeTarget:async()=>{
  if(change==='permission')await saveLetterPermission(ctx,{companyId:b.companyId,capability:'approve',role:'hr_admin',allowed:false});
  if(change==='module')await setModule(b.tenantId,'notifications',null);
  if(change==='consent')await saveLetterEmailPreferences(reviewer,{enabled:false,locale:'ms'},null);
  if(change==='address')await owner.db.update(s.person).set({primaryEmail:'changed-address@fixture.test'}).where(eq(s.person.id,personId));
  if(change==='identity')await owner.db.update(s.appExternalIdentity).set({revokedAt:new Date()}).where(eq(s.appExternalIdentity.appUserId,reviewer.userId!));
 }});expect(await deliverLetterEmailsFromSweep(system(),owner,transport)).toMatchObject({attempted:1,failed:0});expect(send).not.toHaveBeenCalled();expect((await jobs())[0]).toMatchObject({status:'skipped',lastError:'notEligible',startedAt:null});
});
it('records missing transport once and retries only the administrator-selected failure',async()=>{
 await projectLetterNotificationsFromSweep(system(),owner);const offline:NotificationEmailTransport=async<T>()=>({version:1,ready:false,letters:true}) as T;expect(await deliverLetterEmailsFromSweep(system(),owner,offline)).toMatchObject({attempted:0,failedUnstarted:1,unavailable:true});const [job]=await jobs();expect(job).toMatchObject({status:'failed',lastError:'relayUnavailable',startedAt:null,attempts:1});const {send,transport}=sender();expect(await deliverLetterEmailsFromSweep(system(),owner,transport)).toMatchObject({attempted:0});
 const log=await readNotificationEmailDeliveries(ctx);expect(log).toHaveLength(1);expect(JSON.stringify(log)).not.toContain(email);await retryNotificationEmail(ctx,job.id,true);expect(await deliverLetterEmailsFromSweep(system(),owner,transport)).toMatchObject({attempted:1,failed:0});expect(send).toHaveBeenCalledOnce();expect((await jobs())[0].status).toBe('sent');
});
it('honors a definitive temporary rejection and its retry deadline across concurrent sweeps',async()=>{
 await projectLetterNotificationsFromSweep(system(),owner);const send=vi.fn().mockRejectedValueOnce({responseCode:451}).mockResolvedValue(undefined),{transport}=sender({send});const results=await Promise.all([deliverLetterEmailsFromSweep(system(),owner,transport),deliverLetterEmailsFromSweep(system(),owner,transport)]);expect(results.reduce((sum,result)=>sum+result.attempted,0)).toBe(1);const [job]=await jobs();expect(job).toMatchObject({status:'pending',attempts:1,lastError:'smtpTemporary',startedAt:null});expect(send).toHaveBeenCalledOnce();expect(await deliverLetterEmailsFromSweep(system(),owner,transport)).toMatchObject({attempted:0});
 await owner.db.update(s.notificationDelivery).set({nextAttemptAt:sql`now()`}).where(eq(s.notificationDelivery.id,job.id));expect(await deliverLetterEmailsFromSweep(system(),owner,transport)).toMatchObject({attempted:1,failed:0});expect(send).toHaveBeenCalledTimes(2);expect((await jobs())[0]).toMatchObject({status:'sent',attempts:2,lastError:null});
});
it('holds a send with a lost durable result as uncertain instead of blindly resending',async()=>{
 await projectLetterNotificationsFromSweep(system(),owner);const {send,transport}=sender({loseCommit:true});expect(await deliverLetterEmailsFromSweep(system(),owner,transport)).toMatchObject({attempted:1,failed:0});const [job]=await jobs();expect(job.status).toBe('pending');expect(job.startedAt).not.toBeNull();await owner.db.update(s.notificationDelivery).set({leaseUntil:sql`now()-interval '1 second'`}).where(eq(s.notificationDelivery.id,job.id));
 expect(await deliverLetterEmailsFromSweep(system(),owner,transport)).toMatchObject({attempted:0,uncertain:1,failed:0});expect((await jobs())[0]).toMatchObject({status:'failed',lastError:'uncertain'});expect(send).toHaveBeenCalledOnce();expect(await deliverLetterEmailsFromSweep(system(),owner,transport)).toMatchObject({attempted:0});
});
it('prevents ordinary web connections from minting leases and keeps the private role outside HR storage',async()=>{
 await projectLetterNotificationsFromSweep(system(),owner);await expect(deliverLetterEmailsFromSweep(ctx,owner,relay)).rejects.toThrow();await expect(deliverLetterEmailsFromSweep(system(),{withTenant},relay)).rejects.toThrow();const [job]=await jobs();await expect(withTenant(ctx,tx=>tx.update(s.notificationDelivery).set({leaseToken:randomUUID(),letterPreparedStamp:'forged',letterPreparedUntil:new Date(Date.now()+3600000)}).where(eq(s.notificationDelivery.id,job.id)))).rejects.toThrow();
 await expect(raw.begin(async tx=>{await tx.unsafe('SET LOCAL ROLE "'+role+'"');return tx`select * from person`;})).rejects.toThrow();expect(await target(job.id,randomUUID())).toBeNull();await expect(withTenant(ctx,tx=>tx.execute(sql`select app.letter_permission_for_user_at(${b.tenantId}::uuid,${reviewer.userId}::uuid,${b.companyId}::uuid,'read')`))).rejects.toThrow();
});
