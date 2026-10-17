/** Actual0552 + canonical Auth/settings owners. Renderer alone is a fixed RPC fixture.
 * Programmatic password/MFA/session/SMTP-test receipt fixtures are NOT human/provider/Linux proof. */
import {and,eq} from 'drizzle-orm';
import {generate} from 'otplib';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {adminCtx,closeAll,createAppUser,harnessSnapshot,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {client,type SessionContext} from '../db/client';
import {bootstrapInternalOwner} from '../lib/internal-auth/bootstrap';
import {changeInitialPassword,credentialByLogin,startLogin,verifyMfa} from '../lib/internal-auth/service';
import {readRecord} from '../lib/internal-auth/record-store';
import {internalEmailRequest} from '../lib/internal-auth/mail';
import {executeReportBrokerRequest,type ReportBrokerDependencies} from '../lib/internal-auth/report-broker';
import {openReportInspection} from '../lib/internal-auth/report-broker-proof';
import type {ReportBrokerResponse} from '../lib/internal-auth/report-broker-model';
import type {Credential} from '../lib/internal-auth/credential';
import {hireEmployee} from '../core/org';
import {saveNotificationEmailPolicy,saveNotificationEmailPreferences} from '../core/notification-email';
import {saveEmployeeMasterReport} from '../core/employee-master-reports';
import {saveEmployeeMasterSchedule} from '../core/employee-master-schedules';
import {defaultMasterColumn} from '../lib/employee-master-report';
import {PERSONNEL_FIELDS} from '../lib/personnel-field-registry';
import {todayInKualaLumpur} from '../lib/hr-date';
import {fingerprintReportBytes} from '../lib/employee-master-artifact';
import {XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE} from '../lib/email-attachment';
import * as schema from '../db/schema';
const session=vi.hoisted(()=>({ctx:null as SessionContext|null,identity:null as {issuer:string;subject:string;email:string;emailVerified:boolean}|null}));
vi.mock('../lib/internal-auth/web-session',()=>({currentInternalIdentity:async()=>session.identity}));
vi.mock('../lib/session',()=>({getSession:async()=>session.ctx}));
const origin='https://broker-db.test',temporary='Fictional enrollment phrase 771!',password='Fictional replacement phrase 883!';
const artifact=fingerprintReportBytes(Buffer.from('PK fictional test artifact'),XLSX_EMAIL_ATTACHMENT_CONTENT_TYPE);
let b:Base,ownerCtx:SessionContext,recipientCtx:SessionContext,recipient:Awaited<ReturnType<typeof hireEmployee>>,recipientCredential:Credential,ownerCredential:Credential,reportId:string,scheduleId:string,nonce:{occurrenceId:string;leaseToken:string};
beforeAll(migrateTestDb);
afterEach(()=>{vi.unstubAllEnvs();session.ctx=null;session.identity=null;});afterAll(closeAll);
async function enroll(appUserId:string,username:string,email:string){
 await bootstrapInternalOwner(owner.client,{appUserId,organization:'report-broker',username,email,password:temporary,installationOperator:true});
 const login=await startLogin({organization:'report-broker',username,password:temporary,native:false});if(login.step!=='password')throw new Error('Expected canonical password challenge');
 const setup=await changeInitialPassword(login.challenge,password);if(setup.step!=='enroll'||!setup.secret)throw new Error('Expected canonical MFA setup');
 expect((await verifyMfa(setup.challenge,await generate({secret:setup.secret}))).step).toBe('complete');
 const credential=await credentialByLogin('report-broker',username);if(!credential)throw new Error('Missing canonical credential');return credential;
}
async function applyRelay(){
 // Session acquisition is the test adapter; identity values originate from real enrolled Auth records.
 session.ctx=recipientCtx;session.identity={issuer:recipientCredential.issuer,subject:recipientCredential.subject,email:recipientCredential.email,emailVerified:recipientCredential.emailVerified};
 const actor={userId:recipientCtx.userId!,tenantId:b.tenantId,issuer:recipientCredential.issuer,subject:recipientCredential.subject};
 const view=await internalEmailRequest<{revision:string}>({op:'view',actor});
 await internalEmailRequest({op:'save',actor,revision:view.revision,config:{host:'smtp.example.test',port:465,security:'tls',from:'sender@example.test',fromName:'Fictional',replyTo:'',auth:true,user:'relay'},password:'synthetic-relay-password'});
 const draft=await internalEmailRequest<{draft:{id:string}}>({op:'view',actor});
 await internalEmailRequest({op:'test',actor,draftId:draft.draft.id},async()=>{});
 await internalEmailRequest({op:'apply',actor,draftId:draft.draft.id,received:true});
}
beforeEach(async()=>{vi.stubEnv('EMPLOYEE_MASTER_SCHEDULED_EMAIL_ENABLED','true');
 await resetDb();b=await seedBase();await setModule(b.tenantId,'notifications','active');ownerCtx={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};
 vi.stubEnv('AUTH_PROVIDER','internal');vi.stubEnv('AUTH_PUBLIC_ORIGIN',origin);vi.stubEnv('AUTH_SESSION_KEY','6'.repeat(64));
 recipient=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional broker recipient',primaryEmail:'recipient@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const userId=await createAppUser(b.tenantId,recipient.personId,'hr_admin');
 recipientCtx={tenantId:b.tenantId,userId,personId:recipient.personId,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}],entitlements:harnessSnapshot(b.tenantId)};
 recipientCredential=await enroll(userId,'recipient','recipient@example.test');ownerCredential=await enroll(b.adminUserId,'owner','owner@example.test');
 await applyRelay();await saveNotificationEmailPolicy(adminCtx(b),['employee_master_reports']);
 await saveNotificationEmailPreferences(recipientCtx,recipient.employmentId,['employee_master_reports'],'en',{issuer:recipientCredential.issuer,subject:recipientCredential.subject,email:recipientCredential.email,emailVerified:recipientCredential.emailVerified});
 const field=PERSONNEL_FIELDS.find(field=>field.owner==='employment'&&field.ownerField==='employeeCode');if(!field)throw new Error('Missing actual registry field');
 const report=await saveEmployeeMasterReport(ownerCtx,[b.companyId],{name:'Fictional broker report',description:'',sharedRoleIds:['hr_admin'],spec:{v:2,asAt:todayInKualaLumpur(),companyIds:[b.companyId],includeDrafts:false,columns:[defaultMasterColumn(field)],expression:{id:'root',type:'group',logic:'and',children:[]},sorts:[],groups:[],pdf:{paper:'A4',orientation:'landscape',margins:'normal',logo:false,pageBreakGroups:false}}});reportId=report.id;
 scheduleId=(await saveEmployeeMasterSchedule(ownerCtx,[b.companyId],{reportId:report.id,version:report.version,enabled:true,config:{frequency:'weekly',day:1,hour:9,minute:0,timezone:'Asia/Kuala_Lumpur'},recipients:[{userId,employmentId:recipient.employmentId}]})).id;
 const due=new Date(Date.now()-1000),before=new Date(due.getTime()-1000);
 await owner.db.update(schema.notificationPref).set({updatedAt:before,reportConsentVerifiedAt:before}).where(and(eq(schema.notificationPref.tenantId,b.tenantId),eq(schema.notificationPref.category,'employee_master_reports')));
 await owner.db.update(schema.notificationEmailPolicy).set({updatedAt:before}).where(and(eq(schema.notificationEmailPolicy.tenantId,b.tenantId),eq(schema.notificationEmailPolicy.category,'employee_master_reports')));
 await owner.db.update(schema.customReportSchedule).set({nextRunAt:due}).where(eq(schema.customReportSchedule.id,scheduleId));
 expect((await owner.client`select identity_email.queue_report(${scheduleId}::uuid,${due.toISOString()}::timestamptz,${new Date(Date.now()+86400000).toISOString()}::timestamptz) added`)[0].added).toBe(1);
 const jobs=await owner.client`select * from identity_email.claim_reports(1)`;expect(jobs).toHaveLength(1);nonce={occurrenceId:String(jobs[0].id),leaseToken:String(jobs[0].lease_token)};
});
function dependencies():ReportBrokerDependencies {
 return {transaction:async work=>{const result=await client.begin(async tx=>({value:await work(tx)}));return result.value;},authorizeArtifact:async input=>({accessStamp:input.expectedAccessStamp,artifact})};
}
async function inspected(d=dependencies()){
 const value=await executeReportBrokerRequest({phase:'inspect',...nonce},d);
 if(!('ok'in value)||!value.ok||value.phase!=='inspect')throw new Error('Expected real broker inspect');return value;
}
function start(proof:string,d=dependencies()):Promise<ReportBrokerResponse>{return executeReportBrokerRequest({phase:'start',...nonce,inspectionProof:proof,expectedArtifact:artifact},d);}
async function state(){return (await owner.client`select status,started_at,artifact_sha256,artifact_byte_length from custom_report_occurrence where id=${nonce.occurrenceId}::uuid`)[0];}
describe('real broker composition through canonical Auth/settings/0552 owners',()=>{
 it('binds separate owner/recipient real credentials, starts once, pins exact artifact and returns only active relay',async()=>{
  const inspection=await inspected(),proof=openReportInspection(inspection.inspectionProof,nonce)!;
  expect(proof.identities.owner.subject).toBe(ownerCredential.subject);expect(proof.identities.recipient.subject).toBe(recipientCredential.subject);expect(proof.identities.owner.userId).toBe(b.adminUserId);expect(proof.identities.recipient.userId).toBe(recipientCtx.userId);expect(proof.identities.owner.personId).toBeNull();
  const result=await start(inspection.inspectionProof);expect(result).toMatchObject({ok:true,phase:'start',target:{reportId},artifact,relay:{password:'synthetic-relay-password'}});expect(JSON.stringify(result)).not.toContain('totpSecret');expect(JSON.stringify(result)).not.toContain('drafts');
  expect(await state()).toMatchObject({status:'started',artifact_sha256:artifact.sha256,artifact_byte_length:artifact.byteLength});
  expect(await start(inspection.inspectionProof)).toEqual({ok:false,reason:'notEligible'});
 });
 it.each(['consent','binding','ownerArchive','contact','relayRevision'] as const)('refuses real inspected state drift and leaves no partial artifact/start: %s',async kind=>{
  const inspection=await inspected();
  if(kind==='consent')await saveNotificationEmailPreferences(recipientCtx,recipient.employmentId,[],'en',null);
  if(kind==='binding')await owner.db.update(schema.appExternalIdentity).set({revokedAt:new Date()}).where(and(eq(schema.appExternalIdentity.issuer,recipientCredential.issuer),eq(schema.appExternalIdentity.subject,recipientCredential.subject)));
  if(kind==='ownerArchive')await owner.db.update(schema.appUser).set({archivedAt:new Date()}).where(eq(schema.appUser.id,b.adminUserId));
  if(kind==='contact')await owner.db.update(schema.person).set({primaryEmail:'changed@example.test'}).where(eq(schema.person.id,recipient.personId));
  if(kind==='relayRevision')await applyRelay();
  expect(await start(inspection.inspectionProof)).toEqual({ok:false,reason:'notEligible'});expect(await state()).toMatchObject({status:'pending',started_at:null,artifact_sha256:null,artifact_byte_length:null});
 });
 it('compares the renderer fetched manifest and refuses the sender expected fingerprint before a final transaction',async()=>{
  const inspection=await inspected(),d=dependencies();let transactions=0;const original=d.transaction;d.transaction=async work=>{transactions++;return original(work);};
  expect(await executeReportBrokerRequest({phase:'start',...nonce,inspectionProof:inspection.inspectionProof,expectedArtifact:{...artifact,sha256:'f'.repeat(64)}},d)).toEqual({ok:false,reason:'generationFailed'});expect(transactions).toBe(0);expect((await state()).status).toBe('pending');
 });
 it('rolls back a start performed in the caller Tx when the final owner/connection fails before commit',async()=>{
  const inspection=await inspected(),d=dependencies(),failure=new Error('Synthetic final connection failure');
  d.transaction=async work=>{const value=await client.begin(async tx=>{await work(tx);throw failure;});return value;};
  await expect(start(inspection.inspectionProof,d)).rejects.toBe(failure);expect(await state()).toMatchObject({status:'pending',started_at:null,artifact_sha256:null});
 });
 it('reports structural/active relay readiness without occurrence authority or private data',async()=>{
  expect(await executeReportBrokerRequest({phase:'status'},dependencies())).toEqual({available:true});
  const stored=await readRecord<{revision:string}>(client,'email-state');expect(stored?.revision).not.toBe('initial');
 });
});
