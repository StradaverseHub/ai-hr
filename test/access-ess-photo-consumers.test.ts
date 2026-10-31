/** Prepared actual service/route/RLS cases. Not executed during the source-only lease wait. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {db,withTenant,type SessionContext,type Tx} from '../db/client';
import {appendEvent,actorOf} from '../db/events';
import {pgSqlState} from '../lib/db-error';
import {profileChangeRequest,profilePhotoProposal,domainEvent,person,employment,employeeQualification} from '../db/schema';
import {hireEmployee} from '../core/org';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {setOwnPersonPhoto,getProfilePhotoProposal,getPersonPhoto,setPersonPhoto} from '../core/person-photo';
import {decideProfileChange,myProfileChangeRequests,pendingProfileTaskMetadata} from '../core/profile';
import {saveProfileRoutingPolicy,previewProfileRoutingPolicy,rerouteProfileRequest,profileRequestType,profileRequestTypeSql} from '../core/profile-routing';
import {saveOwnPhotoSubmissionSetting} from '../core/profile-edit-policy';
import {EMPTY_PROFILE_ROUTING,type ProfileRouteRule} from '../lib/profile-routing-policy';
import {todayInKualaLumpur} from '../lib/hr-date';
import {saveProfileEditPolicy} from '../core/profile-edit-policy';
import {readOwnProfileWorkspace,submitOwnProfileEdit} from '../core/profile-edit';
import {addQualification,listQualifications} from '../core/qualifications';
import {updateQualification as directlyMaintainQualification} from '../core/workforce-registers';

const routeSession=vi.hoisted(()=>({ctx:null as SessionContext|null}));
vi.mock('../lib/session',()=>({getSession:async()=>{if(!routeSession.ctx)throw new Error('No fixture identity');return routeSession.ctx;}}));
import {GET} from '../app/(app)/me/photo-proposal/[requestId]/route';
let b:Base;
const admin=()=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]});
const old=Buffer.from([137,80,78,71,13,10,26,10,1]),next=Buffer.from([137,80,78,71,13,10,26,10,2]);
beforeAll(migrateTestDb);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 await owner.db.execute(sql`update access_capability set supported=false,bindings='[]'::jsonb where id in ('workforce.view','workforce.maintain','profile.review')`);
 await owner.db.execute(sql`update access_capability set supported=true,bindings='[{"owner":"app.access_profile_review_permitted","operation":"review"}]'::jsonb where id='profile.review'`);
});
afterAll(closeAll);
async function worker(name:string,role:'hr_admin'|'employee'){
 const hired=await hireEmployee(admin(),{person:{fullName:name,primaryEmail:`${randomUUID()}@example.invalid`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
 const userId=await createAppUser(b.tenantId,hired.personId,role);
 return {...hired,ctx:{...admin(),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]} satisfies SessionContext};
}
async function override(userId:string,effect:'allow'|'deny'|null,capabilityId='profile.review'){
 const current=await withTenant(admin(),tx=>accessConfigurationStore.loadCurrent(tx,admin()));
 const edit={expectedRevision:current.snapshot.revision,command:{kind:'setOverride' as const,userId,capabilityId,companyId:b.companyId,effect}};
 const preview=await previewAccessConfiguration(admin(),edit,accessConfigurationStore);
 return saveAccessConfiguration(admin(),{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore);
}
async function route(subject:string,reviewer:string,revision=EMPTY_PROFILE_ROUTING.revision,requestType:'photo'|'fields'='photo'){
 const rule:ProfileRouteRule={id:randomUUID(),name:'Fictional assigned photo reviewer',approverEmploymentId:reviewer,employmentIds:[subject],criteria:{},excludedEmploymentIds:[],excludedCriteria:{},requestTypes:[requestType]};
 const preview=await previewProfileRoutingPolicy(admin(),{version:2,enabled:true,rules:[rule]});
 return saveProfileRoutingPolicy(admin(),{version:2,expectedRevision:revision,enabled:true,rules:[rule],previewFingerprint:preview.fingerprint});
}
async function fieldRequest(){
 const subject=await worker('Fictional field applicant','employee'),reviewer=await worker('Fictional field reviewer','hr_admin');
 // Exercise the existing route byte contract with strings that cannot be compacted by removing spaces.
 await owner.db.update(employment).set({orgDivision:'Fictional "quoted" division \\ தமிழ\nline'}).where(eq(employment.id,subject.employmentId));
 await route(subject.employmentId,reviewer.employmentId,EMPTY_PROFILE_ROUTING.revision,'fields');
 const first='profile.personal_details.firstname',gender='profile.personal_details.gender';
 await saveProfileEditPolicy(admin(),{keys:[first,gender],withdrawnReason:'Fictional field setup'});
 const view=await readOwnProfileWorkspace(subject.ctx,{employmentId:subject.employmentId});
 const result=await submitOwnProfileEdit(subject.ctx,{employmentId:subject.employmentId,proposal:{v:2,fields:[
  {fieldId:first,before:view.baselines[first],value:'Fictional approved தமிழ'},
  {fieldId:gender,before:view.baselines[gender],value:'female'},
 ],registers:[]}});
 expect(result.requestId).toBeTruthy();
 await owner.db.execute(sql`update access_capability set supported=true,bindings='[{"owner":"draft-workforce-consumer-fixture","operation":"maintain"}]'::jsonb where id='workforce.maintain'`);
 await override(reviewer.ctx.userId!,'deny','workforce.maintain');
 return {subject,reviewer,requestId:result.requestId!};
}
async function rawApprove(tx:Tx,ctx:SessionContext,requestId:string,employmentId:string,audit=true){
 await tx.update(profileChangeRequest).set({status:'approved',decidedAt:sql`now()`}).where(eq(profileChangeRequest.id,requestId));
 if(audit)await appendEvent(tx,{tenantId:ctx.tenantId,aggregateType:'profile-change',aggregateId:requestId,eventType:'profile-change.approved',actor:actorOf(ctx),subjectEmploymentId:employmentId,payload:{decision:'approved',deciderEmploymentId:null,reasonGiven:false}});
}
async function refused(work:Promise<unknown>){const error=await work.then(()=>null,error=>error);expect(error).not.toBeNull();expect(pgSqlState(error)).toBe('42501');}
async function fixture(){
 const subject=await worker('Fictional photo subject','employee'),reviewer=await worker('Fictional assigned HR','hr_admin'),other=await worker('Fictional replacement HR','hr_admin');
 const routing=await route(subject.employmentId,reviewer.employmentId);
 await saveOwnPhotoSubmissionSetting(admin(),{enabled:true,withdrawnReason:'Fictional setup'});
 await setPersonPhoto(admin(),{personId:subject.personId,content:old,fileName:'old.png',mimeType:'image/png',sizeBytes:old.length});
 const {requestId}=await setOwnPersonPhoto(subject.ctx,{employmentId:subject.employmentId,content:next,fileName:'proposal.png'});
 return {subject,reviewer,other,routing,requestId};
}
async function photo(ctx:SessionContext,requestId:string){routeSession.ctx=ctx;return GET(new Request(`http://localhost/me/photo-proposal/${requestId}`),{params:Promise.resolve({requestId})});}
describe('effective Security review permission across pending ESS photo consumers',()=>{
 it('classifies bounded queue metadata exactly like the route writer without reading proposal content',async()=>{
  const values=[null,{},[],{v:2},{v:3},{v:'3'},{v:3,kind:'photo'},{v:4},'3',3,[{v:3}]];
  for(const value of values){
   const [row]=await withTenant(admin(),tx=>tx.execute<{kind:string}>(sql`select ${profileRequestTypeSql(sql`${JSON.stringify(value)}::jsonb`)} as kind`));
   expect(row.kind).toBe(profileRequestType(value));
  }
 });

 it('routes photo task metadata through an actual type-only owner while private proposals stay unreadable',async()=>{
  const {subject,reviewer,other,requestId}=await fixture(),foreign=await seedBase();
  const kind=async(ctx:SessionContext,id=requestId)=>{
   const [row]=await withTenant(ctx,tx=>tx.execute<{kind:string|null}>(sql`select app.profile_task_request_type(${id}::uuid) as kind`));return row.kind;
  };
  expect(await kind(reviewer.ctx)).toBe('photo');
  expect(await kind(subject.ctx)).toBeNull();expect(await kind(other.ctx)).toBeNull();
  expect(await kind(adminCtx(foreign))).toBeNull();expect(await kind(reviewer.ctx,randomUUID())).toBeNull();
  await owner.db.execute(sql`REVOKE SELECT ON public.profile_change_request FROM ai_hr_app`);
  await owner.db.execute(sql`GRANT SELECT(id,tenant_id,employment_id,person_id,status,created_at,route_id,route_revision,route_approver_user_id,route_approver_employment_id,route_context) ON public.profile_change_request TO ai_hr_app`);
  try{
   await refused(withTenant(reviewer.ctx,tx=>tx.select({proposal:profileChangeRequest.proposed}).from(profileChangeRequest)));
   expect((await pendingProfileTaskMetadata(reviewer.ctx)).map(row=>row.id)).toEqual([requestId]);
   expect(await kind(reviewer.ctx)).toBe('photo');
  }finally{
   await owner.db.execute(sql`GRANT SELECT ON public.profile_change_request TO ai_hr_app`);
   await owner.db.execute(sql`REVOKE SELECT(id,tenant_id,employment_id,person_id,status,created_at,route_id,route_revision,route_approver_user_id,route_approver_employment_id,route_context) ON public.profile_change_request FROM ai_hr_app`);
  }
  await override(reviewer.ctx.userId!,'deny');
  expect(await kind(reviewer.ctx)).toBeNull();expect(await pendingProfileTaskMetadata(reviewer.ctx)).toEqual([]);
 });

 it('revokes queue-side bytes, raw rows, real route and decision in an already signed-in reviewer context',async()=>{
  const {subject,reviewer,requestId}=await fixture();
  const before=await photo(reviewer.ctx,requestId);expect(before.status).toBe(200);expect(Buffer.from(await before.arrayBuffer())).toEqual(next);
  await override(reviewer.ctx.userId!,'deny');
  expect(await getProfilePhotoProposal(reviewer.ctx,requestId)).toBeNull();expect((await photo(reviewer.ctx,requestId)).status).toBe(404);
  const raw=await withTenant(reviewer.ctx,async tx=>{await tx.execute(sql`select set_config('app.profile_route_maintenance','on',true)`);return tx.select({id:profilePhotoProposal.requestId}).from(profilePhotoProposal).where(eq(profilePhotoProposal.requestId,requestId));});expect(raw).toEqual([]);
  await expect(decideProfileChange(reviewer.ctx,{requestId,decision:'approved'})).rejects.toThrow();
  expect((await photo(subject.ctx,requestId)).status).toBe(200);expect((await getPersonPhoto(subject.ctx,subject.personId))?.content).toEqual(old);
  expect((await myProfileChangeRequests(subject.ctx)).find(row=>row.id===requestId)?.status).toBe('pending');
  await override(reviewer.ctx.userId!,null);await decideProfileChange(reviewer.ctx,{requestId,decision:'approved'});
  expect((await getPersonPhoto(subject.ctx,subject.personId))?.content).toEqual(next);expect((await photo(subject.ctx,requestId)).status).toBe(404);
 });
 it('removes old byte access after reasoned reassignment and refuses assigning a denied reviewer',async()=>{
  const {subject,reviewer,other,routing,requestId}=await fixture();await override(other.ctx.userId!,'deny');
  await expect(route(subject.employmentId,other.employmentId,routing.revision)).rejects.toThrow();
  await override(other.ctx.userId!,null);await route(subject.employmentId,other.employmentId,routing.revision);
  await rerouteProfileRequest(admin(),{requestId,reason:'Fictional named reviewer replacement'});
  expect((await photo(reviewer.ctx,requestId)).status).toBe(404);expect((await photo(other.ctx,requestId)).status).toBe(200);
  await expect(decideProfileChange(reviewer.ctx,{requestId,decision:'approved'})).rejects.toThrow();
 });
 it('keeps an eligible photo approval distinct from denied direct Workforce photo maintenance',async()=>{
  const {subject,reviewer,requestId}=await fixture();
  await owner.db.execute(sql`update access_capability set supported=true,bindings='[{"owner":"draft-workforce-consumer-fixture","operation":"maintain"}]'::jsonb where id='workforce.maintain'`);
  await override(reviewer.ctx.userId!,'deny','workforce.maintain');
  await expect(setPersonPhoto(reviewer.ctx,{personId:subject.personId,content:next,fileName:'direct.png',mimeType:'image/png',sizeBytes:next.length})).rejects.toThrow('Employee record or permission is unavailable.');
  expect((await getPersonPhoto(subject.ctx,subject.personId))?.content).toEqual(old);
  await decideProfileChange(reviewer.ctx,{requestId,decision:'approved'});
  expect((await getPersonPhoto(subject.ctx,subject.personId))?.content).toEqual(next);
  expect(await owner.db.select().from(profilePhotoProposal).where(eq(profilePhotoProposal.requestId,requestId))).toEqual([]);
 });
 it('keeps canonical register approval separate from denied direct Workforce maintenance',async()=>{
  const subject=await worker('Fictional qualification applicant','employee'),reviewer=await worker('Fictional qualification reviewer','hr_admin');
  const first=await addQualification(admin(),{employmentId:subject.employmentId,qualification:'Bachelor',isHighest:true});
  const second=await addQualification(admin(),{employmentId:subject.employmentId,qualification:'Master',isHighest:false});
  const highest='qualification.academic_and_professional_qualifications.highest';
  await saveProfileEditPolicy(admin(),{keys:[highest],withdrawnReason:'Fictional setup'});
  const view=await readOwnProfileWorkspace(subject.ctx,{employmentId:subject.employmentId}),row=view.registers.find(item=>item.id===second.id)!;
  const result=await submitOwnProfileEdit(subject.ctx,{employmentId:subject.employmentId,proposal:{v:2,fields:[],registers:[{kind:'qualification',id:second.id,clientId:second.id,fields:[{fieldId:highest,before:row.baselines[highest],value:true}]}]}});
  expect(result.requestId).toBeTruthy();
  await owner.db.execute(sql`update access_capability set supported=true,bindings='[{"owner":"draft-workforce-consumer-fixture","operation":"maintain"}]'::jsonb where id='workforce.maintain'`);
  await override(reviewer.ctx.userId!,'deny','workforce.maintain');
  await expect(directlyMaintainQualification(reviewer.ctx,{id:second.id,isHighest:true})).rejects.toThrow('Employee record or permission is unavailable.');
  await decideProfileChange(reviewer.ctx,{requestId:result.requestId!,decision:'approved'});
  const after=await listQualifications(subject.ctx,{employmentId:subject.employmentId});
  expect(after.find(item=>item.id===first.id)?.isHighest).toBe(false);expect(after.find(item=>item.id===second.id)?.isHighest).toBe(true);
 });
 it('requires completion, exact values and immutable audit for scalar writes by a reviewer denied direct maintenance',async()=>{
  const {subject,reviewer,requestId}=await fieldRequest();
  const snapshot=async()=>({person:await owner.db.select().from(person).where(eq(person.id,subject.personId)),request:await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,requestId)),events:await owner.db.select({id:domainEvent.id}).from(domainEvent).orderBy(domainEvent.id)});
  const before=await snapshot();
  for(const course of ['pending-only','prepared-only','no-audit','extra-field','wrong-value'] as const){
   await refused(withTenant(reviewer.ctx,async tx=>{
    await tx.execute(sql`select set_config('app.profile_route_maintenance','on',true),set_config('app.profile_write_approved','true',true)`);
    if(course!=='pending-only')await tx.execute(sql`select app.access_profile_value_begin(${requestId}::uuid)`);
    await tx.update(person).set({firstName:course==='wrong-value'?'Unsubmitted value':'Fictional approved தமிழ',gender:'female',...(course==='extra-field'?{lastName:'Unsubmitted surname'}:{})}).where(eq(person.id,subject.personId));
    if(!['pending-only','prepared-only'].includes(course))await rawApprove(tx,reviewer.ctx,requestId,subject.employmentId,course!=='no-audit');
   }));
   expect(await snapshot()).toEqual(before);
  }
  // This changes a routing-input field. SQL must check the before snapshot rather than invalidate
  // the exact change it just authorized, and must agree with the JS fingerprint for Unicode/escapes.
  await decideProfileChange(reviewer.ctx,{requestId,decision:'approved'});
  const [after]=await owner.db.select({firstName:person.firstName,gender:person.gender}).from(person).where(eq(person.id,subject.personId));
  expect(after).toEqual({firstName:'Fictional approved தமிழ',gender:'female'});
  const [request]=await owner.db.select({status:profileChangeRequest.status}).from(profileChangeRequest).where(eq(profileChangeRequest.id,requestId));expect(request.status).toBe('approved');
  await refused(withTenant(reviewer.ctx,tx=>tx.execute(sql`select app.access_profile_value_begin(${requestId}::uuid)`)));
  await refused(withTenant(reviewer.ctx,tx=>tx.update(person).set({firstName:'Later replay'}).where(eq(person.id,subject.personId))));
 });
 it('does not manufacture, retarget, rewrite or reopen a request as a replacement for denied direct maintenance',async()=>{
  const {subject,reviewer,requestId}=await fieldRequest();
  await refused(withTenant(reviewer.ctx,tx=>tx.insert(profileChangeRequest).values({tenantId:b.tenantId,employmentId:subject.employmentId,personId:subject.personId,proposed:{v:2,fields:[],registers:[]}})));
  await refused(withTenant(reviewer.ctx,tx=>tx.update(profileChangeRequest).set({proposed:{v:2,fields:[],registers:[]}}).where(eq(profileChangeRequest.id,requestId))));
  await decideProfileChange(reviewer.ctx,{requestId,decision:'approved'});
  await refused(withTenant(reviewer.ctx,tx=>tx.update(profileChangeRequest).set({status:'pending',decidedAt:null}).where(eq(profileChangeRequest.id,requestId))));
 });
 it('refuses a real foreign request identity at the fixed SQL admission owner',async()=>{
  const foreign=await seedBase();
  const outside=await hireEmployee({...adminCtx(foreign),grants:[{role:'hr_admin',companyId:null}]},{person:{fullName:'Fictional foreign applicant',primaryEmail:`${randomUUID()}@example.invalid`},companyId:foreign.companyId,departmentId:foreign.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
  const {reviewer}=await fieldRequest();
  const [request]=await owner.db.insert(profileChangeRequest).values({tenantId:foreign.tenantId,employmentId:outside.employmentId,personId:outside.personId,proposed:{v:2,fields:[],registers:[]}}).returning({id:profileChangeRequest.id});
  await refused(withTenant(reviewer.ctx,tx=>tx.execute(sql`select app.access_profile_value_begin(${request.id}::uuid)`)));
  expect((await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,request.id)))[0].status).toBe('pending');
 });
 it('refuses an old repeatable-read policy snapshot after a completed closure, including a newly inserted setting',async()=>{
  const {subject,reviewer,requestId}=await fieldRequest();
  const [before]=await owner.db.select({firstName:person.firstName,gender:person.gender}).from(person).where(eq(person.id,subject.personId));
  // A direct owner removal models the real never-configured legacy generation. The anchor remains.
  await owner.db.execute(sql`delete from tenant_setting where tenant_id=${b.tenantId}::uuid and key='ess.profile_change_fields'`);
  let signal!:()=>void,resume!:()=>void,reached=false;
  const pinned=new Promise<void>(resolve=>{signal=resolve;}),changed=new Promise<void>(resolve=>{resume=resolve;});
  const outcome=db.transaction(async tx=>{
   const ctx=reviewer.ctx;
   await tx.execute(sql`select set_config('app.tenant_id',${ctx.tenantId},true),set_config('app.user_id',${ctx.userId!},true),set_config('app.roles','hr_admin',true),set_config('app.grants',${JSON.stringify(ctx.grants)},true)`);
   await tx.select({id:person.id}).from(person).where(eq(person.id,subject.personId));
   reached=true;signal();await changed;
   await tx.execute(sql`select app.access_profile_value_begin(${requestId}::uuid)`);
   await tx.update(person).set({firstName:'Fictional approved தமிழ',gender:'female'}).where(eq(person.id,subject.personId));
   await rawApprove(tx,ctx,requestId,subject.employmentId);
  },{isolationLevel:'repeatable read'}).then(()=>null,error=>{signal();return error;});
  await pinned;
  try{expect(reached).toBe(true);await saveProfileEditPolicy(admin(),{keys:[],withdrawnReason:'Fictional completed closure'});}
  finally{resume();}
  expect(pgSqlState(await outcome)).toBe('40001');
  const [after]=await owner.db.select({firstName:person.firstName,gender:person.gender}).from(person).where(eq(person.id,subject.personId));
  expect(after).toEqual(before);
  expect((await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,requestId)))[0].status).toBe('rejected');
 });
 it('binds a newly requested register entry once, with atomic refusal of duplicate physical inserts',async()=>{
  const subject=await worker('Fictional new qualification applicant','employee'),reviewer=await worker('Fictional new qualification reviewer','hr_admin');
  const level='qualification.academic_and_professional_qualifications.level';
  await saveProfileEditPolicy(admin(),{keys:[level],withdrawnReason:'Fictional new-entry setup'});
  const result=await submitOwnProfileEdit(subject.ctx,{employmentId:subject.employmentId,proposal:{v:2,fields:[],registers:[{kind:'qualification',id:null,clientId:'fictional_new',fields:[{fieldId:level,before:null,value:'Master'}]}]}});
  const requestId=result.requestId!;expect(requestId).toBeTruthy();
  await owner.db.execute(sql`update access_capability set supported=true,bindings='[{"owner":"draft-workforce-consumer-fixture","operation":"maintain"}]'::jsonb where id='workforce.maintain'`);
  await override(reviewer.ctx.userId!,'deny','workforce.maintain');
  await refused(withTenant(reviewer.ctx,async tx=>{
   await tx.execute(sql`select app.access_profile_value_begin(${requestId}::uuid)`);
   await tx.insert(employeeQualification).values([0,1].map(()=>({tenantId:b.tenantId,employmentId:subject.employmentId,qualification:'Master'})));
   await rawApprove(tx,reviewer.ctx,requestId,subject.employmentId);
  }));
  expect(await owner.db.select().from(employeeQualification).where(eq(employeeQualification.employmentId,subject.employmentId))).toEqual([]);
  expect((await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,requestId)))[0].status).toBe('pending');
  await decideProfileChange(reviewer.ctx,{requestId,decision:'approved'});
  expect(await listQualifications(subject.ctx,{employmentId:subject.employmentId})).toHaveLength(1);
 });
 it('retains a write-only privacy consequence for a configuration administrator denied merit review',async()=>{
  const {subject,reviewer,requestId}=await fixture();await override(b.adminUserId,'deny');
  expect(await getProfilePhotoProposal(admin(),requestId)).toBeNull();
  expect(await saveOwnPhotoSubmissionSetting(admin(),{enabled:false,withdrawnReason:'Fictional privacy closure'})).toEqual({withdrawn:1});
  expect(await owner.db.select().from(profilePhotoProposal).where(eq(profilePhotoProposal.requestId,requestId))).toEqual([]);
  const [row]=await owner.db.select({status:profileChangeRequest.status,reason:profileChangeRequest.decisionReason}).from(profileChangeRequest).where(eq(profileChangeRequest.id,requestId));expect(row).toEqual({status:'rejected',reason:'Fictional privacy closure'});
  expect((await photo(subject.ctx,requestId)).status).toBe(404);expect((await photo(reviewer.ctx,requestId)).status).toBe(404);
  expect((await getPersonPhoto(subject.ctx,subject.personId))?.content).toEqual(old);
  const events=await owner.db.select({payload:domainEvent.payload}).from(domainEvent).where(and(eq(domainEvent.aggregateId,requestId),eq(domainEvent.eventType,'profile-change.rejected')));expect(events).toHaveLength(1);expect(events[0].payload).toEqual({decision:'rejected',via:'field-locked',fields:['profile.personal_details.photo'],reasonGiven:true});
 });
 it('serialises a new review denial with approval without a partial master/request outcome',async()=>{
  const {subject,reviewer,requestId}=await fixture();
  const [denial,decision]=await Promise.allSettled([override(reviewer.ctx.userId!,'deny'),decideProfileChange(reviewer.ctx,{requestId,decision:'approved'})]);
  expect(denial.status).toBe('fulfilled');
  const [row]=await owner.db.select({status:profileChangeRequest.status}).from(profileChangeRequest).where(eq(profileChangeRequest.id,requestId));
  if(decision.status==='fulfilled'){
   expect(row.status).toBe('approved');expect((await getPersonPhoto(subject.ctx,subject.personId))?.content).toEqual(next);
   expect(await owner.db.select().from(profilePhotoProposal).where(eq(profilePhotoProposal.requestId,requestId))).toEqual([]);
  }else{
   expect(row.status).toBe('pending');expect((await getPersonPhoto(subject.ctx,subject.personId))?.content).toEqual(old);
   expect((await getProfilePhotoProposal(subject.ctx,requestId))?.content).toEqual(next);
  }
  expect(await getProfilePhotoProposal(reviewer.ctx,requestId)).toBeNull();
 });
 it('rolls back a privacy setting, rejection and byte purge when the real consequence audit fails',async()=>{
  const {subject,requestId}=await fixture();
  await owner.db.execute(sql.raw("CREATE FUNCTION app.test_access_photo_audit_refusal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='profile-change.rejected' AND NEW.payload->>'via'='field-locked' THEN RAISE EXCEPTION 'fictional withdrawal audit refusal' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$"));
  await owner.db.execute(sql.raw('CREATE TRIGGER test_access_photo_audit_refusal BEFORE INSERT ON domain_event FOR EACH ROW EXECUTE FUNCTION app.test_access_photo_audit_refusal()'));
  try{await expect(saveOwnPhotoSubmissionSetting(admin(),{enabled:false,withdrawnReason:'Fictional rollback'})).rejects.toThrow();}
  finally{await owner.db.execute(sql.raw('DROP TRIGGER test_access_photo_audit_refusal ON domain_event'));await owner.db.execute(sql.raw('DROP FUNCTION app.test_access_photo_audit_refusal()'));}
  expect((await getProfilePhotoProposal(subject.ctx,requestId))?.content).toEqual(next);
  expect((await myProfileChangeRequests(subject.ctx)).find(row=>row.id===requestId)?.status).toBe('pending');
  expect((await getPersonPhoto(subject.ctx,subject.personId))?.content).toEqual(old);
  expect(await setOwnPersonPhoto(subject.ctx,{employmentId:subject.employmentId,content:next,fileName:'retry.png'})).toEqual({requestId});
 });
 it('does not treat proposal envelope keys as withdrawable personnel fields',async()=>{
  const {subject,requestId}=await fixture();
  await expect(withTenant(admin(),tx=>tx.execute(sql`select app.access_withdraw_profile_requests('["v"]'::jsonb,'Invalid envelope key')`))).rejects.toThrow();
  expect((await photo(subject.ctx,requestId)).status).toBe(200);
 });
 it('does not let an employee call the write-only withdrawal owner using forged role names',async()=>{
  const {subject,requestId}=await fixture();
  await expect(withTenant({...subject.ctx,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]},tx=>tx.execute(sql`select app.access_withdraw_profile_requests('["profile.personal_details.photo"]'::jsonb,'Forged configuration actor')`))).rejects.toThrow();
  expect((await photo(subject.ctx,requestId)).status).toBe(200);
 });
});
