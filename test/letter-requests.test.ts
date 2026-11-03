/** AI v2 Phase 1, slice 3 — employee letter requests (migration 0961) on fictional data, through the real owners, roles and
 * forced row-level security.
 *
 * Proves: "employees may request" is off by default, set only by HR holding `settings`, audited, and enforced by the
 * database (a direct insert for a closed template is refused); the employee reads only their own requests, HR holding
 * `generate` reads and handles them, and another employee, an HR user without `generate` and another tenant read nothing;
 * the lifecycle requested -> in progress -> issued (only with its own issued letter) and -> declined (with a reason), with
 * one open request per letter type and final states; every change has its domain event, none carrying the purpose or the
 * decline reason; and the employee's decline notice carries nothing beyond the status. */
import {randomUUID} from 'node:crypto';
import {asc,eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import * as s from '../db/schema';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {createLetterDraftBatch,decideLetter,decideLetterTemplate,getLetterGenerationBatch,issueLetter,saveLetterField,saveLetterPermission,saveLetterPolicy,
 saveLetterTemplate,submitLetterBatch} from '../core/letters';
import {countWaitingLetterRequests,declineLetterRequest,getLetterRequestForStaff,LetterRequestError,listLetterRequestOptions,listLetterRequestsForStaff,
 listMyLetterRequests,listRequestableLetterTypes,saveLetterRequestOptions,submitLetterRequest} from '../core/letter-requests';
import {dispatchNotifications,listNotifications} from '../core/notifications';
import {LetterWorkflowError,type LetterPolicy} from '../lib/letter-workflow';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base,hr:SessionContext,reviewer:SessionContext,templateId:string,versionId:string,closedTemplateId:string;
type Person={ctx:SessionContext&{userId:string};personId:string;employmentId:string};
let aina:Person,badrul:Person;
const today=()=>todayInKualaLumpur();
const custom=(ids:string[])=>Object.fromEntries(ids.map(id=>[id,{effectiveDate:{kind:'date' as const,value:today()}}]));
const PURPOSE='Fictional purpose: housing loan at a fictional bank';
const REASON='Fictional reason: the probation review is still open';

async function hire(name:string,code:string,role:'employee'|'manager'='employee'):Promise<Person>{
 const hired=await hireEmployee(hr,{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2025-01-01',employeeCode:code,
  person:{fullName:name,primaryEmail:randomUUID()+'@fixture.test'}});
 const userId=await createAppUser(b.tenantId,hired.personId,role);
 return{ctx:{...await entitledCtx(b,[role]),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]},personId:hired.personId,employmentId:hired.employmentId};
}
const refusedWith=async(promise:Promise<unknown>,code:string)=>{const error=await promise.then(()=>null,(caught:unknown)=>caught);expect(error).toBeInstanceOf(LetterRequestError);expect((error as LetterRequestError).code).toBe(code);};
const visible=(ctx:SessionContext)=>withTenant(ctx,tx=>tx.select({id:s.letterRequest.id}).from(s.letterRequest)).then(rows=>rows.map(row=>row.id).sort());
const stored=(id:string)=>owner.db.select().from(s.letterRequest).where(eq(s.letterRequest.id,id)).then(rows=>rows[0]);
const events=(id:string)=>owner.db.select({type:s.domainEvent.eventType,payload:s.domainEvent.payload,subject:s.domainEvent.subjectEmploymentId}).from(s.domainEvent)
 .where(eq(s.domainEvent.aggregateId,id)).orderBy(asc(s.domainEvent.sequence));
const open=(templates:string[])=>saveLetterRequestOptions(hr,{companyId:b.companyId,changes:templates.map(id=>({templateId:id,requestable:true}))});

beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 vi.stubEnv('AUTH_PROVIDER','workos');vi.stubEnv('NEXT_PUBLIC_WORKOS_REDIRECT_URI','https://letters.fixture.test/callback');
 // Notifications on from the start, so every context's entitlement snapshot includes it (the decline notice).
 await resetDb();b=await seedBase();await setModule(b.tenantId,'notifications','active');hr=await entitledCtx(b);
 const [reviewerPerson]=await owner.db.insert(s.person).values({tenantId:b.tenantId,fullName:'Fictional signatory',primaryEmail:'letter-request-signatory@fixture.test'}).returning();
 reviewer={...hr,userId:await createAppUser(b.tenantId,reviewerPerson.id,'hr_admin'),personId:reviewerPerson.id};
 aina=await hire('Aina Fictional','LR-0001');badrul=await hire('Badrul Fictional','LR-0002');
 const name=await saveLetterField(hr,{companyId:b.companyId,definition:{key:'employeeName',label:'Employee name',description:'Canonical name',kind:'text',source:'employee.name',required:true,editable:false,sensitive:false},active:true});
 const date=await saveLetterField(hr,{companyId:b.companyId,definition:{key:'effectiveDate',label:'Effective date',description:'Date entered for this letter',kind:'date',source:'custom.date',required:true,editable:true,sensitive:false},active:true});
 const made=async(code:string,title:string)=>{const template=await saveLetterTemplate(hr,{companyId:b.companyId,code,name:title,category:'confirmation',effectiveFrom:today(),
   document:{version:1,language:'en',blocks:[{type:'paragraph',content:[{type:'text',text:'This confirms that '},{type:'field',key:'employeeName'},{type:'text',text:' is employed, as at '},{type:'field',key:'effectiveDate'}]}]},fieldVersionIds:[name.id,date.id]});
  await decideLetterTemplate(hr,{versionId:template.versionId,expectedStatus:'draft',action:'submit'});await decideLetterTemplate(reviewer,{versionId:template.versionId,expectedStatus:'submitted',action:'approve'});return template;};
 const confirmation=await made('EMPCONF','Fictional Employment Confirmation Letter');templateId=confirmation.templateId;versionId=confirmation.versionId;
 closedTemplateId=(await made('SALARY','Fictional Salary Letter')).templateId;
 const policy:LetterPolicy={version:1,stages:[{key:'signatory',label:'Authorised signatory',userIds:[reviewer.userId!],allowDelegation:false}],signatoryUserId:reviewer.userId!,signingMode:'authenticated',signatureAssetId:null,letterheadAssetId:null,referenceFormat:'HR/{YYYY}/{SEQ:6}',retentionDays:365,sensitiveLinkMinutes:15,acknowledgement:'none',approvalDueHours:48,acknowledgementDueDays:7,reminderHours:24,escalationUserId:null,portalNotifications:false,emailNotifications:false};
 await saveLetterPolicy(hr,{companyId:b.companyId,category:'confirmation',policy,enabled:true});
});

describe('which letters employees may request',()=>{
 it('is off by default, set only by HR holding settings, audited, and enforced by the database',async()=>{
  expect(await listRequestableLetterTypes(aina.ctx)).toEqual([]);
  await refusedWith(submitLetterRequest(aina.ctx,{templateId}),'not_requestable');
  // Straight past the owner service: the database's own guard refuses a template that is not open for requests.
  await expect(withTenant(aina.ctx,tx=>tx.insert(s.letterRequest).values({tenantId:b.tenantId,companyId:b.companyId,employmentId:aina.employmentId,requestedBy:aina.ctx.userId,
   templateId,letterTypeName:'Forged name'}))).rejects.toThrow();
  expect((await listLetterRequestOptions(hr,b.companyId)).map(row=>[row.code,row.name,row.requestable])).toEqual([
   ['EMPCONF','Fictional Employment Confirmation Letter',false],['SALARY','Fictional Salary Letter',false]]);
  await refusedWith(saveLetterRequestOptions(aina.ctx,{companyId:b.companyId,changes:[{templateId,requestable:true}]}),'permission');
  await refusedWith(listLetterRequestOptions(aina.ctx,b.companyId),'permission');
  expect(await open([templateId])).toEqual({changed:1});
  // Saving the same state again changes nothing and records nothing.
  expect(await open([templateId])).toEqual({changed:0});
  const audit=await events(templateId);
  expect(audit.filter(row=>row.type==='letter-request-option.changed').map(row=>row.payload)).toEqual([{companyId:b.companyId,templateId,from:false,to:true}]);
  expect(await listRequestableLetterTypes(aina.ctx)).toEqual([{employmentId:aina.employmentId,companyId:b.companyId,companyName:expect.any(String),templateId,name:'Fictional Employment Confirmation Letter'}]);
  await refusedWith(submitLetterRequest(aina.ctx,{templateId:closedTemplateId}),'not_requestable');
  // Turned off again: no longer offered, and a new request is refused.
  expect(await saveLetterRequestOptions(hr,{companyId:b.companyId,changes:[{templateId,requestable:false}]})).toEqual({changed:1});
  expect(await listRequestableLetterTypes(aina.ctx)).toEqual([]);
  await refusedWith(submitLetterRequest(aina.ctx,{templateId}),'not_requestable');
 });
});

describe('who reads a letter request',()=>{
 it('the employee reads their own, HR holding generate reads and handles it; another employee, HR without generate and another tenant read nothing',async()=>{
  await open([templateId]);
  const {requestId}=await submitLetterRequest(aina.ctx,{templateId,purpose:'  '+PURPOSE+'  '});
  const row=await stored(requestId);
  expect(row).toMatchObject({status:'requested',employmentId:aina.employmentId,companyId:b.companyId,requestedBy:aina.ctx.userId,letterTypeName:'Fictional Employment Confirmation Letter',
   purpose:PURPOSE,letterId:null,declineReason:null,handledBy:null,version:1});
  expect((await listMyLetterRequests(aina.ctx)).map(own=>[own.id,own.letterTypeName,own.status,own.letterId])).toEqual([[requestId,'Fictional Employment Confirmation Letter','requested',null]]);
  expect(await visible(aina.ctx)).toEqual([requestId]);
  // HR holding generate (the company's HR administrator, by default).
  const staff=await listLetterRequestsForStaff(hr,{companyId:b.companyId});
  expect(staff.map(item=>[item.id,item.employeeName,item.employeeCode,item.purpose,item.publishedVersionId])).toEqual([[requestId,'Aina Fictional','LR-0001',PURPOSE,versionId]]);
  expect(await countWaitingLetterRequests(hr,[b.companyId])).toBe(1);
  // Another employee.
  expect(await visible(badrul.ctx)).toEqual([]);expect(await listMyLetterRequests(badrul.ctx)).toEqual([]);
  expect(await getLetterRequestForStaff(badrul.ctx,requestId)).toBeNull();await refusedWith(listLetterRequestsForStaff(badrul.ctx,{companyId:b.companyId}),'permission');
  // The employee's own request never counts as HR's work for them.
  expect(await countWaitingLetterRequests(aina.ctx,[b.companyId])).toBe(0);
  // An HR user who reads letters but does not hold generate.
  const clerk=await hire('Clerk Fictional','LR-0003','manager');
  await saveLetterPermission(hr,{companyId:b.companyId,capability:'read',role:'manager',allowed:true});
  expect(await visible(clerk.ctx)).toEqual([]);await refusedWith(listLetterRequestsForStaff(clerk.ctx,{companyId:b.companyId}),'permission');
  expect(await countWaitingLetterRequests(clerk.ctx,[b.companyId])).toBe(0);
  // Another tenant's administrator.
  const other=await seedBase(),outsider=await entitledCtx(other);
  expect(await visible(outsider)).toEqual([]);expect(await getLetterRequestForStaff(outsider,requestId)).toBeNull();
  // The employee cannot change their request, nor create one for someone else.
  await withTenant(aina.ctx,tx=>tx.update(s.letterRequest).set({status:'declined',declineReason:'Forged'}).where(eq(s.letterRequest.id,requestId)));
  expect((await stored(requestId)).status).toBe('requested');
  await refusedWith(submitLetterRequest(aina.ctx,{templateId,employmentId:badrul.employmentId}),'not_requestable');
  await expect(withTenant(aina.ctx,tx=>tx.insert(s.letterRequest).values({tenantId:b.tenantId,companyId:b.companyId,employmentId:badrul.employmentId,requestedBy:aina.ctx.userId,
   templateId,letterTypeName:'x'}))).rejects.toThrow();
  expect(await owner.db.select({id:s.letterRequest.id}).from(s.letterRequest)).toHaveLength(1);
 });
});

describe('the lifecycle',()=>{
 it('one open request per letter type; decline needs a reason and the current version, is final, and tells the employee only the status',async()=>{
  await open([templateId]);
  const {requestId}=await submitLetterRequest(aina.ctx,{templateId,purpose:PURPOSE});
  await refusedWith(submitLetterRequest(aina.ctx,{templateId}),'duplicate');
  await refusedWith(declineLetterRequest(hr,{requestId,reason:'   ',expectedVersion:1}),'invalid');
  await refusedWith(declineLetterRequest(hr,{requestId,reason:REASON,expectedVersion:2}),'stale');
  await refusedWith(declineLetterRequest(badrul.ctx,{requestId,reason:REASON,expectedVersion:1}),'permission');
  expect(await declineLetterRequest(hr,{requestId,reason:REASON,expectedVersion:1})).toEqual({requestId});
  expect(await stored(requestId)).toMatchObject({status:'declined',declineReason:REASON,handledBy:hr.userId,version:2});
  await refusedWith(declineLetterRequest(hr,{requestId,reason:REASON,expectedVersion:2}),'state');
  // The database refuses any move out of a final state, whoever asks.
  await expect(withTenant(hr,tx=>tx.update(s.letterRequest).set({status:'requested'}).where(eq(s.letterRequest.id,requestId)))).rejects.toThrow();
  // The employee sees the status, never HR's reason.
  const own=(await listMyLetterRequests(aina.ctx))[0];expect(own).toMatchObject({id:requestId,status:'declined',letterId:null});expect(JSON.stringify(own)).not.toContain(REASON);
  // The notice says only that it was declined.
  await dispatchNotifications(adminCtx(b),{});
  const notices=(await listNotifications(aina.ctx)).filter(notice=>notice.kind==='letter-request.declined');
  expect(notices.map(notice=>[notice.title,notice.body,notice.linkPath])).toEqual([['Letter request declined','Your letter request was declined. Open My Letters to see its status.','/me/letters']]);
  expect(JSON.stringify(notices)).not.toMatch(/Fictional Employment Confirmation|Fictional reason|Fictional purpose/);
  // A declined request no longer blocks a new one.
  const again=await submitLetterRequest(aina.ctx,{templateId});expect(again.requestId).not.toBe(requestId);
  // Audit: one event per change, none carrying the purpose or the reason.
  const audit=await events(requestId);
  expect(audit.map(row=>[row.type,row.subject])).toEqual([['letter-request.submitted',aina.employmentId],['letter-request.declined',aina.employmentId]]);
  expect(JSON.stringify(audit)).not.toMatch(/Fictional reason|Fictional purpose/);
 });

 it('HR prepares the letter from the request, it moves to issued only with its own letter, and stays final',async()=>{
  await open([templateId]);
  const {requestId}=await submitLetterRequest(aina.ctx,{templateId});
  // A draft for someone else cannot be this request's letter.
  await expect(createLetterDraftBatch(hr,{companyId:b.companyId,templateVersionId:versionId,employmentIds:[badrul.employmentId],customValues:custom([badrul.employmentId]),operationKey:randomUUID(),requestId}))
   .rejects.toBeInstanceOf(LetterWorkflowError);
  // Nor can one batch for two employees.
  await expect(createLetterDraftBatch(hr,{companyId:b.companyId,templateVersionId:versionId,employmentIds:[aina.employmentId,badrul.employmentId],customValues:custom([aina.employmentId,badrul.employmentId]),operationKey:randomUUID(),requestId}))
   .rejects.toMatchObject({code:'invalid'});
  expect((await stored(requestId)).status).toBe('requested');
  const made=await createLetterDraftBatch(hr,{companyId:b.companyId,templateVersionId:versionId,employmentIds:[aina.employmentId],customValues:custom([aina.employmentId]),operationKey:randomUUID(),requestId});
  const row=(await getLetterGenerationBatch(hr,made.batchId))!.rows[0];
  expect(await stored(requestId)).toMatchObject({status:'in_progress',letterId:row.record.id,handledBy:hr.userId});
  expect(await countWaitingLetterRequests(hr,[b.companyId])).toBe(0);
  // Issued is the database's to set, and only once the linked letter is issued.
  await expect(withTenant(hr,tx=>tx.update(s.letterRequest).set({status:'issued'}).where(eq(s.letterRequest.id,requestId)))).rejects.toThrow();
  await submitLetterBatch(hr,made.batchId);
  const submitted=(await getLetterGenerationBatch(hr,made.batchId))!.rows[0];
  await decideLetter(reviewer,{letterId:submitted.record.id,expectedRevisionId:submitted.revision!.id,expectedLockVersion:submitted.record.lockVersion,decision:{action:'approve',comment:'Fictional review of the exact letter',confirmSignature:true}});
  expect((await stored(requestId)).status).toBe('in_progress');
  await issueLetter(hr,{letterId:submitted.record.id,expectedRevisionId:submitted.revision!.id,expectedLockVersion:submitted.record.lockVersion+1});
  expect(await stored(requestId)).toMatchObject({status:'issued',letterId:submitted.record.id,version:3});
  expect((await listMyLetterRequests(aina.ctx))[0]).toMatchObject({id:requestId,status:'issued',letterId:submitted.record.id});
  await refusedWith(declineLetterRequest(hr,{requestId,reason:REASON,expectedVersion:3}),'state');
  const audit=await events(requestId);
  expect(audit.map(entry=>entry.type)).toEqual(['letter-request.submitted','letter-request.in-progress','letter-request.issued']);
  expect(audit[2].payload).toEqual({letterId:submitted.record.id,from:'in_progress',to:'issued'});
  // An unrelated letter's issue touches no request.
  const [count]=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from public.letter_request where status='issued'`);expect(count.n).toBe(1);
 });
});
