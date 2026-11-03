/** AI v2 Phase 1, slice 3 — employee letter requests (migration 0961) on fictional data, through the real owners, roles and
 * forced row-level security.
 *
 * Proves: "employees may request" is off by default, set only by HR holding `settings`, audited, and enforced by the
 * database (a direct insert for a closed template is refused); the employee reads only their own requests, and only through
 * the column-safe own lookup (no SELECT on the table, so HR's reason never reaches them in the database), HR holding
 * `generate` reads and handles them, and another employee, an HR user without `generate` and another tenant read nothing;
 * the lifecycle requested -> in progress -> issued (only with its own issued letter) and -> declined (with a reason), with
 * one open request per letter type and final states; every change has its domain event, none carrying the purpose, the
 * decline reason or the message to the employee; HR's optional message to the employee is written only with a decline
 * and the employee reads it with the declined status, never the reason; and the employee's decline notice carries
 * nothing beyond the status; person erasure clears the purpose, the reason and the message and keeps the request's facts. */
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
import {erasePersonPii} from '../core/pdpa';
import {LetterWorkflowError,type LetterPolicy} from '../lib/letter-workflow';
import {todayInKualaLumpur} from '../lib/hr-date';
import type {Tx} from '../db/client';
import {adminCtx,closeAll,createAppUser,entitledCtx,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';

let b:Base,hr:SessionContext,reviewer:SessionContext,templateId:string,versionId:string,closedTemplateId:string;
type Person={ctx:SessionContext&{userId:string};personId:string;employmentId:string};
let aina:Person,badrul:Person;
const today=()=>todayInKualaLumpur();
const custom=(ids:string[])=>Object.fromEntries(ids.map(id=>[id,{effectiveDate:{kind:'date' as const,value:today()}}]));
const PURPOSE='Fictional purpose: housing loan at a fictional bank';
const REASON='Fictional reason: the probation review is still open';
const MESSAGE='Fictional message: please ask again after your confirmation date';

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
  // The employee holds no SELECT on the table: a direct query returns nothing, and their own requests come only through
  // the column-safe own lookup (listMyLetterRequests above).
  expect(await visible(aina.ctx)).toEqual([]);
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
  // The message to the employee is refused when too long (never cut), and the database never takes one before a decline.
  await refusedWith(declineLetterRequest(hr,{requestId,reason:REASON,employeeMessage:'x'.repeat(501),expectedVersion:1}),'invalid');
  await expect(withTenant(hr,tx=>tx.update(s.letterRequest).set({employeeMessage:MESSAGE}).where(eq(s.letterRequest.id,requestId)))).rejects.toThrow();
  expect(await stored(requestId)).toMatchObject({status:'requested',employeeMessage:null,version:1});
  expect(await declineLetterRequest(hr,{requestId,reason:REASON,employeeMessage:'  '+MESSAGE+'  ',expectedVersion:1})).toEqual({requestId});
  expect(await stored(requestId)).toMatchObject({status:'declined',declineReason:REASON,employeeMessage:MESSAGE,handledBy:hr.userId,version:2});
  // HR reads both; the message is final with the request.
  expect(await getLetterRequestForStaff(hr,requestId)).toMatchObject({declineReason:REASON,employeeMessage:MESSAGE});
  await expect(withTenant(hr,tx=>tx.update(s.letterRequest).set({employeeMessage:'Fictional rewrite'}).where(eq(s.letterRequest.id,requestId)))).rejects.toThrow();
  await refusedWith(declineLetterRequest(hr,{requestId,reason:REASON,expectedVersion:2}),'state');
  // The database refuses any move out of a final state, whoever asks.
  await expect(withTenant(hr,tx=>tx.update(s.letterRequest).set({status:'requested'}).where(eq(s.letterRequest.id,requestId)))).rejects.toThrow();
  // The employee sees the status and HR's message, never HR's reason.
  const own=(await listMyLetterRequests(aina.ctx))[0];expect(own).toMatchObject({id:requestId,status:'declined',letterId:null,employeeMessage:MESSAGE});expect(JSON.stringify(own)).not.toContain(REASON);
  // In the database too: the employee's direct query reaches no row, so neither the reason nor who handled it, and the
  // own lookup has no such column at all.
  expect(await withTenant(aina.ctx,tx=>tx.execute(sql`select decline_reason,handled_by from public.letter_request where id=${requestId}::uuid`))).toEqual([]);
  const [lookup]=await withTenant(aina.ctx,tx=>tx.execute<Record<string,unknown>>(sql`select * from app.letter_requests_own(null) where id=${requestId}::uuid`));
  expect(Object.keys(lookup).sort()).toEqual(['created_at','employee_message','employment_id','id','letter_id','letter_type_name','purpose','status','status_changed_at','template_id']);
  expect(JSON.stringify(lookup)).not.toContain(REASON);
  expect(await withTenant(badrul.ctx,tx=>tx.execute(sql`select id from app.letter_requests_own(null)`))).toEqual([]);
  // The notice says only that it was declined.
  await dispatchNotifications(adminCtx(b),{});
  const notices=(await listNotifications(aina.ctx)).filter(notice=>notice.kind==='letter-request.declined');
  expect(notices.map(notice=>[notice.title,notice.body,notice.linkPath])).toEqual([['Letter request declined','Your letter request was declined. Open My Letters to see its status.','/me/letters']]);
  expect(JSON.stringify(notices)).not.toMatch(/Fictional Employment Confirmation|Fictional reason|Fictional purpose|Fictional message/);
  // A declined request no longer blocks a new one; declined without a message, the employee sees none.
  const again=await submitLetterRequest(aina.ctx,{templateId});expect(again.requestId).not.toBe(requestId);
  await declineLetterRequest(hr,{requestId:again.requestId,reason:REASON,employeeMessage:'   ',expectedVersion:1});
  expect(await stored(again.requestId)).toMatchObject({status:'declined',employeeMessage:null});
  expect((await listMyLetterRequests(aina.ctx)).find(row=>row.id===again.requestId)).toMatchObject({status:'declined',employeeMessage:null});
  // Audit: one event per change, none carrying the purpose or the reason.
  const audit=await events(requestId);
  expect(audit.map(row=>[row.type,row.subject])).toEqual([['letter-request.submitted',aina.employmentId],['letter-request.declined',aina.employmentId]]);
  expect(JSON.stringify(audit)).not.toMatch(/Fictional reason|Fictional purpose|Fictional message/);
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

describe('person erasure',()=>{
 it('clears the person\'s purpose, HR\'s decline reason and the message to them, keeps the request\'s facts, and leaves another person\'s request alone',async()=>{
  await open([templateId]);
  const declined=(await submitLetterRequest(aina.ctx,{templateId,purpose:PURPOSE})).requestId;
  await declineLetterRequest(hr,{requestId:declined,reason:REASON,employeeMessage:MESSAGE,expectedVersion:1});
  const waiting=(await submitLetterRequest(aina.ctx,{templateId,purpose:PURPOSE})).requestId;
  const theirs=(await submitLetterRequest(badrul.ctx,{templateId,purpose:PURPOSE})).requestId;
  const before=await stored(declined);
  const report=await erasePersonPii(hr,{subjectEmploymentId:aina.employmentId,scope:'contact',reason:'Fictional canonical privacy request',requestRef:'fixture-'+randomUUID()});
  expect(report.erased).toContain('letterRequestText');
  // The HR record stays: its letter type, status, times, version and who handled it; its free text is gone.
  expect(await stored(declined)).toMatchObject({status:'declined',purpose:null,declineReason:null,employeeMessage:null,letterTypeName:before.letterTypeName,
   handledBy:hr.userId,createdAt:before.createdAt,statusChangedAt:before.statusChangedAt,version:2,textErasedAt:expect.any(Date)});
  expect(await stored(waiting)).toMatchObject({status:'requested',purpose:null,version:1,textErasedAt:expect.any(Date)});
  expect(await stored(theirs)).toMatchObject({status:'requested',purpose:PURPOSE,textErasedAt:null});
  expect(JSON.stringify(await owner.db.select().from(s.letterRequest).where(eq(s.letterRequest.employmentId,aina.employmentId)))).not.toMatch(/Fictional (purpose|reason|message)/);
  // HR still reads the request, without its text, and it goes on through the usual lifecycle.
  expect(await getLetterRequestForStaff(hr,waiting)).toMatchObject({status:'requested',purpose:null});
  expect(await declineLetterRequest(hr,{requestId:waiting,reason:REASON,expectedVersion:1})).toEqual({requestId:waiting});
  // Outside an admitted erasure the function refuses; nobody clears the text another way.
  await expect(withTenant(hr,tx=>tx.execute(sql`select app.letter_requests_redact(${badrul.employmentId}::uuid)`))).rejects.toThrow();
  await expect(withTenant(hr,tx=>tx.update(s.letterRequest).set({purpose:null}).where(eq(s.letterRequest.id,theirs)))).rejects.toThrow();
  expect((await stored(theirs)).purpose).toBe(PURPOSE);
 });
});

describe('the owner-side paths under a restricted physical owner',()=>{
 /** Acts as the application role for one login inside the shared transaction, as withTenant would. */
 async function as(tx:Tx,ctx:SessionContext){
  const grants=ctx.grants??(ctx.roles??[]).map(role=>({role,companyId:null}));
  await tx.execute(sql`RESET ROLE`);
  await tx.execute(sql`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId??''},true),set_config('app.roles',${(ctx.roles??[]).join(',')},true),
   set_config('app.grants',${JSON.stringify(grants)},true),set_config('app.agent_principal_id','',true)`);
  await tx.execute(sql`SET LOCAL ROLE ai_hr_app`);
 }
 it('the employee\'s own lookup and person erasure work under forced RLS for a NOSUPERUSER, NOBYPASSRLS owner, and neither widens a read',async()=>{
  await open([templateId]);
  const mine=(await submitLetterRequest(aina.ctx,{templateId,purpose:PURPOSE})).requestId,theirs=(await submitLetterRequest(badrul.ctx,{templateId,purpose:PURPOSE})).requestId;
  await declineLetterRequest(hr,{requestId:mine,reason:REASON,employeeMessage:MESSAGE,expectedVersion:1});
  const role='letter_request_owner_'+randomUUID().replaceAll('-',''),rollback=new Error('rollback-restricted-letter-owner');
  let verified=0;
  await expect(owner.withTenant(hr,async tx=>{
   await tx.execute(sql.raw(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`));
   await tx.execute(sql.raw(`GRANT USAGE,CREATE ON SCHEMA public,app TO ${role}`));
   await tx.execute(sql.raw(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO ${role}`));
   for(const table of ['public.app_user','public.person','public.employment','public.company','public.letter_request','app.assistant_review_erasure_intent'])
    await tx.execute(sql.raw(`ALTER TABLE ${table} OWNER TO ${role}`));
   for(const fn of ['app.letter_requests_own(uuid)','app._letter_request_erasure_subject(uuid,uuid)','app.letter_requests_redact(uuid)'])
    await tx.execute(sql.raw(`ALTER FUNCTION ${fn} OWNER TO ${role}`));
   const [shape]=await tx.execute<Record<string,boolean>>(sql`select r.rolsuper as super,r.rolbypassrls as bypass,
    (select c.relforcerowsecurity and c.relowner=r.oid from pg_class c where c.oid='public.letter_request'::regclass) as forced_owned from pg_roles r where r.rolname=${role}`);
   expect(shape).toEqual({super:false,bypass:false,forced_owned:true});
   // The employee: their own request through the lookup, with HR's message and never the reason; nothing directly.
   await as(tx,aina.ctx);
   expect(await tx.execute(sql`select id,purpose,status,employee_message from app.letter_requests_own(null)`)).toEqual([{id:mine,purpose:PURPOSE,status:'declined',employee_message:MESSAGE}]);
   expect(await tx.execute(sql`select id from public.letter_request`)).toEqual([]);
   await as(tx,badrul.ctx);
   expect(await tx.execute(sql`select id from app.letter_requests_own(null)`)).toEqual([{id:theirs}]);
   verified++;
   // Person erasure: the admitted intent for the subject in THIS transaction, then the definer function as HR.
   await tx.execute(sql`RESET ROLE`);
   await tx.execute(sql`insert into app.assistant_review_erasure_intent(xact_id,tenant_id,user_id,person_id,employment_id,cleared,event_id,review_ids)
    values(pg_current_xact_id(),${b.tenantId}::uuid,${hr.userId}::uuid,${aina.personId}::uuid,${aina.employmentId}::uuid,0,null,'{}'::uuid[])`);
   await as(tx,hr);
   expect(await tx.execute(sql`select app.letter_requests_redact(${aina.employmentId}::uuid) as cleared`)).toEqual([{cleared:1}]);
   await tx.execute(sql`RESET ROLE`);
   const rows=await tx.execute<{id:string;purpose:string|null;reason:string|null;message:string|null;erased:boolean;status:string}>(sql`select id,purpose,decline_reason as reason,
    employee_message as message,text_erased_at is not null as erased,status from public.letter_request order by id`);
   expect(rows.map(row=>({...row}))).toEqual([{id:mine,purpose:null,reason:null,message:null,erased:true,status:'declined'},
    {id:theirs,purpose:PURPOSE,reason:null,message:null,erased:false,status:'requested'}].sort((x,y)=>x.id<y.id?-1:1));
   expect(await tx.execute(sql`select current_setting('app.letter_request_erasure',true) as marker`)).toEqual([{marker:''}]);
   verified++;
   throw rollback;
  })).rejects.toBe(rollback);
  expect(verified).toBe(2);
  expect((await stored(mine)).declineReason).toBe(REASON);
 });
});
