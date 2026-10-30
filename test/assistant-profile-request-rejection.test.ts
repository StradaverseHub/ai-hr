/** Real native requests/custody; fictional actors only. No provider or binary workflow. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,afterEach,it,expect,vi} from 'vitest';
import {withTenant,type SessionContext,type Tx} from '../db/client';
import * as schema from '../db/schema';
import * as vault from '../lib/pii/vault';
import {hireEmployee} from '../core/org';
import {createCompany} from '../core/admin';
import {decideProfileChange} from '../core/profile';
import {setTenantSetting} from '../core/tenant-settings';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {readOwnProfileWorkspace,submitOwnProfileEdit} from '../core/profile-edit';
import {saveProfileVisibilityPolicy} from '../core/profile-edit-policy';
import {previewProfileRoutingPolicy,saveProfileRoutingPolicy} from '../core/profile-routing';
import {essVisibleFields} from '../lib/personnel-ess-contract';
import {editableProfileRoute,EMPTY_PROFILE_ROUTING,type ProfileRouteRule} from '../lib/profile-routing-policy';
import {grantAssistant,revokeAssistant} from '../core/assistant-grant';
import {profileRequestRejectionReviews as reviews,readProfileRequestRejectionChoices} from '../core/assistant-actions/profile-request-rejection-review-store';
import {prepareProfileRequestRejectionSourceTx,confirmProfileRequestRejectionSourceTx} from '../core/assistant-actions/profile-request-rejection-source';
import {ProfileRequestRejection as C} from '../lib/assistant-actions/profile-request-rejection-contract';
import {adminCtx,entitledCtx,createAppUser,migrateTestDb,resetDb,seedBase,owner,closeAll,setModule,type Base} from './harness';
let b:Base,subject:{employmentId:string;personId:string},hr:SessionContext;
const group=()=>({...adminCtx(b),grants:[{role:'hr_admin' as const,companyId:null}]});
const hire=(name:string)=>hireEmployee(group(),{person:{fullName:name,primaryEmail:randomUUID()+'@example.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
async function login(role:'hr_admin'|'employee'|'super_admin'='hr_admin',linked=true,companyId:string|null=null){
 const person=linked?await hire('Fictional reviewer'):null;let userId:string;
 if(person)userId=await createAppUser(b.tenantId,person.personId,role);else{const [u]=await owner.db.insert(schema.appUser).values({tenantId:b.tenantId,workosUserId:'user_'+randomUUID(),personId:null}).returning({id:schema.appUser.id});userId=u.id;await owner.db.insert(schema.roleAssignment).values({tenantId:b.tenantId,appUserId:userId,role,companyId});}
 if(person&&companyId)await owner.db.update(schema.roleAssignment).set({companyId}).where(eq(schema.roleAssignment.appUserId,userId));
 await grantAssistant(group(),{appUserId:userId});return {...await entitledCtx(b,[role]),userId,personId:person?.personId??null,grants:[{role,companyId}]} satisfies SessionContext;
}
async function request(proposed:unknown={preferredName:'Private requested name'},person=subject){const [r]=await owner.db.insert(schema.profileChangeRequest).values({tenantId:b.tenantId,employmentId:person.employmentId,personId:person.personId,proposed}).returning({id:schema.profileChangeRequest.id});return r.id;}
const human=(id:string,reason='  Please correct the supporting details.  ',employmentId=subject.employmentId)=>({action:C.action,contractVersion:1,subjectId:id,employmentId,reason});
const confirmation=(r:{actionId:string;reviewedDigest:string})=>({actionId:r.actionId,reviewedDigest:r.reviewedDigest});
async function stored(id:string){const [r]=await owner.db.execute<{state:string;actorPersonId:string|null;subjectPersonId:string;eventId:string|null;bodies:number}>(sql`select r.state,r.person_id as "actorPersonId",r.decision_subject_person_id as "subjectPersonId",r.receipt_event_id as "eventId",(select count(*)::int from app.assistant_own_leave_review_content c where c.action_id=r.id) as bodies from app.assistant_own_leave_review r where r.id=${id}::uuid`);return r;}
async function master(){return {people:await owner.db.select().from(schema.person).where(eq(schema.person.tenantId,b.tenantId)).orderBy(schema.person.id),employment:await owner.db.select().from(schema.employment).where(eq(schema.employment.tenantId,b.tenantId)).orderBy(schema.employment.id),statutory:await owner.db.select().from(schema.employeeStatutoryMy).where(eq(schema.employeeStatutoryMy.tenantId,b.tenantId))};}
async function row(id:string){return (await owner.db.select().from(schema.profileChangeRequest).where(eq(schema.profileChangeRequest.id,id)))[0];}
async function events(id:string){return owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.aggregateId,id)).orderBy(schema.domainEvent.sequence);}
beforeAll(migrateTestDb);afterAll(closeAll);afterEach(()=>vi.unstubAllEnvs());
beforeEach(async()=>{vi.stubEnv('AI_CONFIG_SECRET','fictional-profile-rejection-custody-key');await resetDb();b=await seedBase();await setModule(b.tenantId,'assistant','active');subject=await hire('Fictional requested employee');hr=await login();});
it.each(['legacy','v2'] as const)('reviews and rejects one %s scalar request without copying or applying proposal values',async kind=>{
 const proposed=kind==='legacy'?{preferredName:'Private requested name'}:{v:2,fields:[{fieldId:'profile.personal_details.preferredname',before:null,value:'Private requested name'}],registers:[]},id=await request(proposed),before=await master(),original=await row(id),priorEvents=await events(id);
 const r=(await reviews.prepare(hr,human(id))).review;
 expect(r.review).toMatchObject({subjectId:id,employmentId:subject.employmentId,before:{status:'pending',reason:null},after:{status:'rejected',reason:'Please correct the supporting details.'}});expect(r.review.fieldIds).toEqual(['profile.personal_details.preferredname']);expect(JSON.stringify(r)).not.toContain('Private requested name');expect(await row(id)).toEqual(original);expect(await events(id)).toEqual(priorEvents);expect(await master()).toEqual(before);
 const [done,replay]=await Promise.all([reviews.confirm(hr,confirmation(r)),reviews.confirm(hr,confirmation(r))]);expect(done).toEqual(replay);expect(done.kind).toBe('completed');expect(await reviews.reopen(hr,r.actionId)).toEqual(done);expect(await reviews.confirm(hr,confirmation(r))).toEqual(done);
 expect(await row(id)).toMatchObject({status:'rejected',decisionReason:'Please correct the supporting details.',decidedByEmploymentId:null,proposed});expect(await master()).toEqual(before);expect(await stored(r.actionId)).toMatchObject({state:'completed',bodies:0});
 const audit=(await events(id)).filter(e=>e.eventType==='profile-change.rejected');expect(audit).toHaveLength(1);expect(audit[0]).toMatchObject({actorType:'user',actorId:hr.userId,subjectEmploymentId:subject.employmentId,payload:{decision:'rejected',reasonGiven:true}});expect(JSON.stringify(audit)).not.toContain('Please correct');expect(JSON.stringify(audit)).not.toContain('Private requested name');
 const [proof]=await owner.db.execute<{top:boolean}>(sql`select q.xmin=d.xmin and q.xmin=r.xmin as top from profile_change_request q join domain_event d on d.id=${audit[0].id}::uuid join app.assistant_own_leave_review r on r.id=${r.actionId}::uuid where q.id=${id}::uuid`);expect(proof.top).toBe(true);
});
it('preserves native default transaction and refuses reasonless or caller-owned outer rollback',async()=>{
 const id=await request(),before=await row(id);await expect(decideProfileChange(hr,{requestId:id,decision:'rejected',reason:'  '})).rejects.toThrow();
 await expect(withTenant(hr,async tx=>{const result=await decideProfileChange(hr,{requestId:id,decision:'rejected',reason:'Native rollback'},tx);expect(result.eventId).toMatch(/^[a-f0-9-]{36}$/);throw Error('fictional outer rollback');})).rejects.toThrow('fictional outer rollback');expect(await row(id)).toEqual(before);expect(await events(id)).toHaveLength(0);
 expect(await decideProfileChange(hr,{requestId:id,decision:'rejected',reason:' Native default '})).toEqual({status:'rejected'});expect(await row(id)).toMatchObject({status:'rejected',decisionReason:'Native default'});expect((await events(id))[0].payload).toEqual({decision:'rejected',deciderEmploymentId:null,reasonGiven:true});
});
it('keeps real unlinked USERs separate from the request subject and refuses foreign review custody',async()=>{
 const who=await login('hr_admin',false),foreign=await login('hr_admin',false),id=await request(),r=(await reviews.prepare(who,human(id))).review;
 expect(await stored(r.actionId)).toMatchObject({actorPersonId:null,subjectPersonId:subject.personId,state:'awaiting_confirmation',bodies:1});await expect(reviews.reopen(foreign,r.actionId)).rejects.toThrow();await expect(reviews.confirm(foreign,confirmation(r))).rejects.toThrow();const done=await reviews.confirm(who,confirmation(r));expect(done.kind).toBe('completed');expect(await reviews.reopen(who,r.actionId)).toEqual(done);
});
it('refuses self, employee, missing principal, other company and other tenant before any effect',async()=>{
 const foreignCompany=await createCompany(group(),{legalName:'Fictional foreign company',country:'MY',currency:'MYR'}),id=await request(),employee=await login('employee'),otherCompany=await login('hr_admin',true,foreignCompany.id),foreign=await seedBase();
 // The forged company claim fails the actual-principal guard; no foreign company or access is created.
 for(const who of [employee,otherCompany,{...hr,userId:undefined},{...hr,tenantId:foreign.tenantId},{...hr,personId:subject.personId}])await expect(reviews.prepare(who,human(id))).rejects.toThrow();expect(await row(id)).toMatchObject({status:'pending'});expect(await events(id)).toHaveLength(0);
 const [ownEmployment]=await owner.db.select({id:schema.employment.id}).from(schema.employment).where(eq(schema.employment.personId,hr.personId!));const own=await request(undefined,{employmentId:ownEmployment.id,personId:hr.personId!});await expect(reviews.prepare(hr,human(own))).rejects.toThrow();
});
it.each([
 {v:3,kind:'photo',fieldId:'profile.personal_details.photo'},
 {unknownPrivateField:'never exposed'},
 {v:2,fields:[],registers:[{kind:'dependent',id:null,clientId:'child-1',fields:[{fieldId:'family.family_and_dependents.fullname',before:null,value:'Child'}]}]},
 ['invalid'],
 {preferredName:'x'.repeat(70000)},
])('hands unsupported proposal shapes to native without custody or native changes: %j',async proposed=>{
 const id=await request(proposed),before=await master();await expect(reviews.prepare(hr,human(id))).rejects.toThrow();expect(await row(id)).toMatchObject({status:'pending'});expect(await events(id)).toHaveLength(0);expect(await master()).toEqual(before);const [count]=await owner.db.execute<{n:number}>(sql`select count(*)::int n from app.assistant_own_leave_review where action_kind=${C.action}`);expect(count.n).toBe(0);
});
it('hands attachment-bearing requests off without projecting filename/content',async()=>{
 const id=await request();await owner.db.insert(schema.profileChangeAttachment).values({tenantId:b.tenantId,requestId:id,fieldIds:['profile.personal_details.preferredname'],fileName:'Private supporting evidence.pdf',mimeType:'application/pdf',sizeBytes:8,content:Buffer.from('%PDF-doc')});const result=await readProfileRequestRejectionChoices(hr,{query:'Fictional requested',subjectId:id});expect(result).toEqual({kind:'unavailable'});await expect(reviews.prepare(hr,human(id))).rejects.toThrow();expect(await row(id)).toMatchObject({status:'pending'});
});
it('binds proposal and request route history changes and permits the concurrent native winner',async()=>{
 const id=await request(),r=(await reviews.prepare(hr,human(id))).review;await owner.db.update(schema.profileChangeRequest).set({routeHistory:[{fixture:'route changed'}]}).where(eq(schema.profileChangeRequest.id,id));await expect(reviews.confirm(hr,confirmation(r))).rejects.toThrow();expect(await row(id)).toMatchObject({status:'pending'});
 const second=await request(),saved=(await reviews.prepare(hr,human(second))).review;await decideProfileChange(hr,{requestId:second,decision:'rejected',reason:'Native winner'});await expect(reviews.confirm(hr,confirmation(saved))).rejects.toThrow();expect(await row(second)).toMatchObject({decisionReason:'Native winner'});expect((await events(second)).filter(e=>e.eventType==='profile-change.rejected')).toHaveLength(1);
});
it('rechecks current Assistant grant before unwrap and still permits actor-owned retirement',async()=>{
 const id=await request(),r=(await reviews.prepare(hr,human(id))).review;await revokeAssistant(group(),{appUserId:hr.userId!});const unwrap=vi.spyOn(vault,'unwrapDek').mockImplementation(()=>{throw Error('private body must remain sealed after revocation');});try{await expect(reviews.reopen(hr,r.actionId)).rejects.toThrow();await expect(reviews.confirm(hr,confirmation(r))).rejects.toThrow();expect(await reviews.discard(hr,{actionId:r.actionId})).toMatchObject({kind:'retired',receipt:{state:'discarded'}});expect(unwrap).not.toHaveBeenCalled();expect(await stored(r.actionId)).toMatchObject({state:'discarded',bodies:0});expect(await row(id)).toMatchObject({status:'pending'});}finally{unwrap.mockRestore();}
});
it('narrows current company HR to group admin when the native tenant setting changes',async()=>{
 const companyHr=await login('hr_admin',true,b.companyId),id=await request(),r=(await reviews.prepare(companyHr,human(id))).review;await setTenantSetting(group(),{key:'ess.profile_change_approver',value:'group_admin'});await expect(reviews.reopen(companyHr,r.actionId)).rejects.toThrow();await expect(reviews.confirm(companyHr,confirmation(r))).rejects.toThrow();expect(await row(id)).toMatchObject({status:'pending'});
});
it('refuses old, subtransaction and same-transaction reason-tampered proof',async()=>{
 const id=await request(),r=(await reviews.prepare(hr,human(id))).review;await expect(withTenant(hr,async tx=>{const prepared=await prepareProfileRequestRejectionSourceTx(tx,hr,C.Human.parse(human(id)));const result=await tx.transaction(inner=>confirmProfileRequestRejectionSourceTx(inner,hr,C.Human.parse(human(id)),prepared.reviewedDigest));await tx.execute(sql`select app.assistant_assigned_review_complete(${r.actionId}::uuid,${C.action},${r.reviewedDigest},${result.eventId}::uuid)`);})).rejects.toThrow();expect(await row(id)).toMatchObject({status:'pending'});
 await expect(withTenant(hr,async tx=>{const result=await decideProfileChange(hr,{requestId:id,decision:'rejected',reason:'native reason'},tx);await tx.update(schema.profileChangeRequest).set({decisionReason:'tampered after event'}).where(eq(schema.profileChangeRequest.id,id));await tx.execute(sql`select app.assistant_assigned_review_complete(${r.actionId}::uuid,${C.action},${r.reviewedDigest},${result.eventId}::uuid)`);})).rejects.toThrow();expect(await row(id)).toMatchObject({status:'pending'});
 await decideProfileChange(hr,{requestId:id,decision:'rejected',reason:'old event'});const event=(await events(id))[0];await expect(withTenant(hr,tx=>tx.execute(sql`select app.assistant_assigned_review_complete(${r.actionId}::uuid,${C.action},${r.reviewedDigest},${event.id}::uuid)`))).rejects.toThrow();expect(await stored(r.actionId)).toMatchObject({state:'awaiting_confirmation',bodies:1});
});
it('rolls native row/event and custody back together after late audit failure',async()=>{
 const id=await request(),r=(await reviews.prepare(hr,human(id))).review;await owner.client.unsafe("create function public.ai_reject_late_failure() returns trigger language plpgsql as $$begin if new.event_type='profile-change.rejected' then raise exception 'fictional audit failure';end if;return new;end$$");await owner.client.unsafe('create trigger ai_reject_late_failure before insert on domain_event for each row execute function public.ai_reject_late_failure()');try{await expect(reviews.confirm(hr,confirmation(r))).rejects.toThrow();expect(await row(id)).toMatchObject({status:'pending',decisionReason:null});expect(await events(id)).toHaveLength(0);expect(await stored(r.actionId)).toMatchObject({state:'awaiting_confirmation',bodies:1});}finally{await owner.client.unsafe('drop trigger ai_reject_late_failure on domain_event');await owner.client.unsafe('drop function public.ai_reject_late_failure()');}
});
it('expires pending custody without a native decision and retires the encrypted body',async()=>{
 const id=await request(),r=(await reviews.prepare(hr,human(id))).review;await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=clock_timestamp()-interval '11 minutes',expires_at=clock_timestamp()-interval '1 second' where id=${r.actionId}::uuid`);expect(await reviews.reopen(hr,r.actionId)).toMatchObject({kind:'retired',receipt:{state:'expired'}});expect(await stored(r.actionId)).toMatchObject({state:'expired',bodies:0});expect(await row(id)).toMatchObject({status:'pending'});expect(await events(id)).toHaveLength(0);
});
it('refuses relinked current users before decrypting the original actor body',async()=>{
 const who=await login('hr_admin',false),id=await request(),r=(await reviews.prepare(who,human(id))).review;await owner.db.update(schema.appUser).set({personId:subject.personId}).where(eq(schema.appUser.id,who.userId!));const unwrap=vi.spyOn(vault,'unwrapDek').mockImplementation(()=>{throw Error('relinked actor must not unwrap former custody');});try{await expect(reviews.reopen(who,r.actionId)).rejects.toThrow();await expect(reviews.confirm({...who,personId:subject.personId},confirmation(r))).rejects.toThrow();expect(unwrap).not.toHaveBeenCalled();expect(await stored(r.actionId)).toMatchObject({actorPersonId:null,state:'awaiting_confirmation',bodies:1});expect(await row(id)).toMatchObject({status:'pending'});}finally{unwrap.mockRestore();}
});
it('records native self-call outcome and row/event evidence separately, and refuses composed false-success proof',async()=>{
 const self=await login('super_admin'),[employment]=await owner.db.select({id:schema.employment.id}).from(schema.employment).where(eq(schema.employment.personId,self.personId!)),id=await request(undefined,{employmentId:employment.id,personId:self.personId!}),before=await row(id);
 // JS's shared super-admin exception is not itself proof of a native update: SQL reader/update RLS
 // also excludes own requests. Keep the existing native call result separate from observable effect.
 const native=await Promise.allSettled([decideProfileChange(self,{requestId:id,decision:'rejected',reason:'Native own-request probe'})]);const after=await row(id),audit=await events(id);expect(native[0]).toMatchObject({status:'fulfilled',value:{status:'rejected'}});expect(audit).toHaveLength(1);expect(after.proposed).toEqual(before.proposed);expect(after.status).toBe('pending');expect(audit.every(e=>e.aggregateId===id&&e.actorId===self.userId)).toBe(true);
 await expect(reviews.prepare(self,human(id,'Assistant own rejection',employment.id))).rejects.toThrow();await expect(withTenant(self,tx=>decideProfileChange(self,{requestId:id,decision:'rejected',reason:'Composed own-request refusal'},tx))).rejects.toThrow();expect(await row(id)).toEqual(after);expect(await events(id)).toEqual(audit);
});
it('rejects oversize human reason before custody and permits fresh expiry replacement on the same subject',async()=>{
 const id=await request();await expect(reviews.prepare(hr,human(id,'x'.repeat(2001)))).rejects.toThrow();expect(await row(id)).toMatchObject({status:'pending'});
 const r=(await reviews.prepare(hr,human(id))).review;await owner.db.execute(sql`update app.assistant_own_leave_review set created_at=clock_timestamp()-interval '11 minutes',expires_at=clock_timestamp()-interval '1 second' where id=${r.actionId}::uuid`);const replacement=(await reviews.prepare(hr,human(id,'A fresh reason.'))).review;expect(replacement.actionId).not.toBe(r.actionId);expect(await stored(r.actionId)).toMatchObject({state:'expired',bodies:0});expect(await stored(replacement.actionId)).toMatchObject({state:'awaiting_confirmation',bodies:1});
});
it('uses the real named route snapshot and refuses an unassigned HR or changed dated subject context',async()=>{
 const fieldId='profile.personal_details.preferredname',subjectUser=await createAppUser(b.tenantId,subject.personId,'employee'),subjectCtx={...await entitledCtx(b,['employee']),userId:subjectUser,personId:subject.personId,grants:[{role:'employee' as const,companyId:null}]},other=await login();
 await saveProfileVisibilityPolicy(group(),{policy:{version:5,fields:Object.fromEntries(essVisibleFields().map(field=>[field.id,field.ess.binding&&['immediate','approval'].includes(field.ess.edit)?'editable':'viewOnly'])),primaryOnly:[],groups:{},approvals:{[fieldId]:{required:true,attachmentRequired:false}}},withdrawnReason:'Fictional policy configured'});
 const [hrEmployment]=await owner.db.select({id:schema.employment.id}).from(schema.employment).where(eq(schema.employment.personId,hr.personId!));
 const rule:ProfileRouteRule={...editableProfileRoute({id:randomUUID(),name:'Fictional named HR',approverEmploymentId:hrEmployment.id,employmentIds:[subject.employmentId],criteria:{}}),approverEmploymentIds:[hrEmployment.id]},input={version:3 as const,enabled:true,rules:[rule]},preview=await previewProfileRoutingPolicy(group(),input);await saveProfileRoutingPolicy(group(),{...input,expectedRevision:EMPTY_PROFILE_ROUTING.revision,previewFingerprint:preview.fingerprint});
 const workspace=await readOwnProfileWorkspace(subjectCtx,{employmentId:subject.employmentId}),submitted=await submitOwnProfileEdit(subjectCtx,{employmentId:subject.employmentId,proposal:{v:2,fields:[{fieldId,before:workspace.baselines[fieldId],value:'Private named-route proposal'}],registers:[]}}),id=submitted.requestId!;
 expect(id).toMatch(/^[a-f0-9-]{36}$/);await expect(reviews.prepare(other,human(id))).rejects.toThrow();const r=(await reviews.prepare(hr,human(id))).review;expect(r.review.fieldIds).toEqual([fieldId]);expect(JSON.stringify(r)).not.toContain('Private named-route proposal');
 await owner.db.update(schema.assignment).set({departmentId:b.deptB}).where(eq(schema.assignment.employmentId,subject.employmentId));await expect(reviews.reopen(hr,r.actionId)).rejects.toThrow();await expect(reviews.confirm(hr,confirmation(r))).rejects.toThrow();expect(await row(id)).toMatchObject({status:'pending'});expect((await events(id)).filter(event=>event.eventType==='profile-change.rejected')).toHaveLength(0);
});
/** Reconstruct only this disposable tenant's pre-Access state AFTER every actor/role insertion has
 * committed its deferred native bootstrap trigger. Retain real identities/roles/employment, audit,
 * configuration generation and every trigger. Canonical reinitialization can then install fresh defaults.
 * No role may be inserted after this helper and before the legacy review under test. */
async function legacyUninitializedFixture(){
 const roles=await owner.db.select().from(schema.roleAssignment).where(eq(schema.roleAssignment.tenantId,b.tenantId)).orderBy(schema.roleAssignment.id),audit=await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId,b.tenantId)).orderBy(schema.domainEvent.id);
 expect(roles.some(role=>role.appUserId===b.adminUserId&&role.role==='hr_admin'&&role.companyId===null)).toBe(true);expect(roles.some(role=>role.appUserId===hr.userId&&role.role==='hr_admin')).toBe(true);
 await owner.db.transaction(async tx=>{
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`);
  await tx.execute(sql`delete from access_user_override where tenant_id=${b.tenantId}::uuid`);
  await tx.execute(sql`delete from access_membership where tenant_id=${b.tenantId}::uuid`);
  await tx.execute(sql`delete from access_group_grant where tenant_id=${b.tenantId}::uuid`);
  await tx.execute(sql`delete from access_group where tenant_id=${b.tenantId}::uuid`);
  await tx.execute(sql`delete from access_configuration where tenant_id=${b.tenantId}::uuid`);
 });
 expect(await owner.db.select().from(schema.roleAssignment).where(eq(schema.roleAssignment.tenantId,b.tenantId)).orderBy(schema.roleAssignment.id)).toEqual(roles);expect(await owner.db.select().from(schema.domainEvent).where(eq(schema.domainEvent.tenantId,b.tenantId)).orderBy(schema.domainEvent.id)).toEqual(audit);
 const [authority]=await withTenant(hr,tx=>tx.execute<{principal:boolean;admin:boolean;subject:boolean}>(sql`select app.principal_snapshot_current() as principal,app.is_admin() as admin,app.can_admin_employment(${subject.employmentId}::uuid) as subject`));expect(authority).toEqual({principal:true,admin:true,subject:true});
 const [state]=await owner.db.execute<{configurations:number;groups:number;anchor:boolean}>(sql`select (select count(*)::int from access_configuration where tenant_id=${b.tenantId}::uuid) as configurations,(select count(*)::int from access_group where tenant_id=${b.tenantId}::uuid) as groups,exists(select 1 from app.access_profile_write_generation where tenant_id=${b.tenantId}::uuid) as anchor`);expect(state).toEqual({configurations:0,groups:0,anchor:true});
}
it('supports native legacy HR rejection without initializing Access as a review side effect',async()=>{
 await legacyUninitializedFixture();
 const [before]=await owner.db.execute<{initialized:boolean}>(sql`select exists(select 1 from access_configuration where tenant_id=${b.tenantId}::uuid and initialized) as initialized`);expect(before.initialized).toBe(false);
 const id=await request(),r=(await reviews.prepare(hr,human(id))).review;expect((await reviews.confirm(hr,confirmation(r))).kind).toBe('completed');expect(await row(id)).toMatchObject({status:'rejected',decisionReason:'Please correct the supporting details.'});
 const [after]=await owner.db.execute<{initialized:boolean}>(sql`select exists(select 1 from access_configuration where tenant_id=${b.tenantId}::uuid and initialized) as initialized`);expect(after.initialized).toBe(false);
});
it('invalidates a legacy prepared review when Access is genuinely initialized before confirmation',async()=>{
 await legacyUninitializedFixture();
 const [before]=await owner.db.execute<{initialized:boolean}>(sql`select exists(select 1 from access_configuration where tenant_id=${b.tenantId}::uuid and initialized) as initialized`);expect(before.initialized).toBe(false);
 const id=await request(),r=(await reviews.prepare(hr,human(id))).review;const ctx=group();await withTenant(ctx,tx=>accessConfigurationStore.loadCurrent(tx,ctx));
 await expect(reviews.reopen(hr,r.actionId)).rejects.toThrow();await expect(reviews.confirm(hr,confirmation(r))).rejects.toThrow();expect(await row(id)).toMatchObject({status:'pending',decisionReason:null});expect(await events(id)).toHaveLength(0);expect(await stored(r.actionId)).toMatchObject({state:'awaiting_confirmation',bodies:1});
});
it('keeps the native legacy commitment stable for an uninitialized Access row',async()=>{
 await legacyUninitializedFixture();
 const [before]=await owner.db.execute<{initialized:boolean}>(sql`select exists(select 1 from access_configuration where tenant_id=${b.tenantId}::uuid and initialized) as initialized`);expect(before.initialized).toBe(false);
 const id=await request(),r=(await reviews.prepare(hr,human(id))).review;await owner.db.execute(sql`insert into access_configuration(tenant_id,initialized) values(${b.tenantId}::uuid,false) on conflict(tenant_id) do update set revision=gen_random_uuid() where not access_configuration.initialized`);
 expect((await reviews.reopen(hr,r.actionId)).kind).toBe('prepared');expect((await reviews.confirm(hr,confirmation(r))).kind).toBe('completed');expect(await row(id)).toMatchObject({status:'rejected'});
});
