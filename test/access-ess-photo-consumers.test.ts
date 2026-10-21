/** Prepared actual service/route/RLS cases. Not executed during the source-only lease wait. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {withTenant,type SessionContext} from '../db/client';
import {profileChangeRequest,profilePhotoProposal,domainEvent} from '../db/schema';
import {hireEmployee} from '../core/org';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {setOwnPersonPhoto,getProfilePhotoProposal,getPersonPhoto,setPersonPhoto} from '../core/person-photo';
import {decideProfileChange,myProfileChangeRequests} from '../core/profile';
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
import {GET} from '../app/me/photo-proposal/[requestId]/route';
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
async function route(subject:string,reviewer:string,revision=EMPTY_PROFILE_ROUTING.revision){
 const rule:ProfileRouteRule={id:randomUUID(),name:'Fictional assigned photo reviewer',approverEmploymentId:reviewer,employmentIds:[subject],criteria:{},excludedEmploymentIds:[],excludedCriteria:{},requestTypes:['photo']};
 const preview=await previewProfileRoutingPolicy(admin(),{version:2,enabled:true,rules:[rule]});
 return saveProfileRoutingPolicy(admin(),{version:2,expectedRevision:revision,enabled:true,rules:[rule],previewFingerprint:preview.fingerprint});
}
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
