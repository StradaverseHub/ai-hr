/** Source-prepared integration journeys. Run only in an explicitly granted test/DB window. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {withTenant,type SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {readOwnProfileWorkspace,submitOwnProfileEdit} from '../core/profile-edit';
import {readOwnProfileFacts} from '../core/profile-view';
import {listProfileChangeRequests,decideProfileChange,myProfileChangeRequests} from '../core/profile';
import {saveProfileRoutingPolicy,rerouteProfileRequest,previewProfileRoutingPolicy} from '../core/profile-routing';
import {EMPTY_PROFILE_ROUTING,editableProfileRoute,type ProfileRouteRule} from '../lib/profile-routing-policy';
import {setTenantSetting} from '../core/tenant-settings';
import {essVisibleFields} from '../lib/personnel-ess-contract';
import {saveProfileVisibilityPolicy,saveOwnPhotoSubmissionSetting} from '../core/profile-edit-policy';
import {setOwnPersonPhoto,setPersonPhoto,getPersonPhoto,getProfilePhotoProposal,PHOTO_MAX_BYTES} from '../core/person-photo';
import {person,profileChangeRequest,profilePhotoProposal,personPhoto,roleAssignment} from '../db/schema';
const routeSession=vi.hoisted(()=>({current:null as SessionContext|null}));
vi.mock('../lib/session',()=>({getSession:async()=>{if(!routeSession.current)throw new Error('No fixture identity');return routeSession.current;}}));
import {GET as photoGET} from '../app/(app)/me/photo-proposal/[requestId]/route';
let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const group=(base:Base=b):SessionContext=>({...adminCtx(base),grants:[{role:'hr_admin',companyId:null}]});
async function worker(name:string,role:'employee'|'hr_admin'='employee',base:Base=b){
 const hired=await hireEmployee(group(base),{person:{fullName:name,primaryEmail:`${randomUUID()}@example.test`},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 const userId=await createAppUser(base.tenantId,hired.personId,role);
 return {...hired,ctx:{...adminCtx(base),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]} satisfies SessionContext};
}
function rule(subject:string,approver:string):ProfileRouteRule{return {id:randomUUID(),name:'Named HR fixture',approverEmploymentId:approver,employmentIds:[subject],criteria:{}};}
async function proposed(ctx:SessionContext,employmentId:string,includePhone=false){
 const workspace=await readOwnProfileWorkspace(ctx,{employmentId});
 return {v:2,fields:[{fieldId:'profile.personal_details.firstname',before:workspace.baselines['profile.personal_details.firstname'],value:'Requested name'},...(includePhone?[{fieldId:'profile.contact_and_permanent_address.phone',before:workspace.baselines['profile.contact_and_permanent_address.phone'],value:'0123456789'}]:[])],registers:[]};
}

const png=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
const original=Buffer.from([137,80,78,71,13,10,26,10,9,8,7]);
async function fixture(){
 const employee=await worker('Photo subject'),hr=await worker('Assigned photo HR','hr_admin'),other=await worker('Unrelated HR','hr_admin');
 await saveProfileRoutingPolicy(group(),{expectedRevision:EMPTY_PROFILE_ROUTING.revision,enabled:true,rules:[rule(employee.employmentId,hr.employmentId)]});
 await setTenantSetting(group(),{key:'ess.profile_photo_edit',value:true});
 await setPersonPhoto(group(),{personId:employee.personId,content:original,mimeType:'image/png',fileName:'old.png',sizeBytes:original.length});
 return {employee,hr,other};
}
describe('canonical photo request lifecycle and byte privacy',()=>{
 it('accepts the exact owner size boundary as pending bytes and refuses the next byte without changing the master or request',async()=>{
  const {employee}=await fixture();
  const atLimit=Buffer.alloc(PHOTO_MAX_BYTES);png.copy(atLimit);
  const {requestId}=await setOwnPersonPhoto(employee.ctx,{employmentId:employee.employmentId,content:atLimit,fileName:'bounded.png'});
  expect((await getProfilePhotoProposal(employee.ctx,requestId))?.content.byteLength).toBe(PHOTO_MAX_BYTES);
  await expect(Promise.resolve().then(()=>setOwnPersonPhoto(employee.ctx,{employmentId:employee.employmentId,content:Buffer.concat([atLimit,Buffer.from([0])]),fileName:'oversized.png'}))).rejects.toThrow('Photo exceeds 2 MB');
  expect((await getPersonPhoto(employee.ctx,employee.personId))?.content).toEqual(original);
  const requests=await owner.db.select({id:profileChangeRequest.id}).from(profileChangeRequest).where(and(eq(profileChangeRequest.personId,employee.personId),eq(profileChangeRequest.status,'pending'))).orderBy(profileChangeRequest.id);
  expect(requests).toEqual([{id:requestId}]);
 });
 it('keeps the master unchanged until HR approves, reuses exact pending retries and purges proposal bytes after approval',async()=>{
  const {employee,hr}=await fixture();
  const submitted=await setOwnPersonPhoto(employee.ctx,{employmentId:employee.employmentId,content:png,fileName:'PRIVATE-FILENAME.png'});
  expect((await getPersonPhoto(employee.ctx,employee.personId))?.content).toEqual(original);
  expect((await getProfilePhotoProposal(employee.ctx,submitted.requestId))?.content).toEqual(png);
  expect((await getProfilePhotoProposal(hr.ctx,submitted.requestId))?.content).toEqual(png);
  expect(await setOwnPersonPhoto(employee.ctx,{employmentId:employee.employmentId,content:png,fileName:'retry.png'})).toEqual(submitted);
  const [stored]=await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,submitted.requestId));
  expect(JSON.stringify(stored.proposed)).not.toContain('PRIVATE-FILENAME');expect(JSON.stringify((await myProfileChangeRequests(employee.ctx))[0].proposed)).not.toContain('baselineHash');
  await decideProfileChange(hr.ctx,{requestId:submitted.requestId,decision:'approved'});
  expect((await getPersonPhoto(employee.ctx,employee.personId))?.content).toEqual(png);
  expect(await owner.db.select().from(profilePhotoProposal).where(eq(profilePhotoProposal.requestId,submitted.requestId))).toEqual([]);
  expect(await getProfilePhotoProposal(hr.ctx,submitted.requestId)).toBeNull();
  expect((await myProfileChangeRequests(employee.ctx)).find(row=>row.id===submitted.requestId)?.status).toBe('approved');
 });
 it('serializes identical concurrent submissions to one request and refuses competing pending bytes',async()=>{
  const {employee}=await fixture();
  const submit=(content:Buffer)=>setOwnPersonPhoto(employee.ctx,{employmentId:employee.employmentId,content,fileName:'race.png'});
  const [first,second]=await Promise.all([submit(png),submit(png)]);
  expect(first).toEqual(second);
  const distinct=Buffer.concat([png,Buffer.from([7])]);
  const attempts=await Promise.allSettled([submit(png),submit(distinct)]);
  expect(attempts[0]).toMatchObject({status:'fulfilled',value:first});
  expect(attempts[1]).toMatchObject({status:'rejected',reason:{code:'stale'}});
  const rows=await owner.db.select({id:profileChangeRequest.id}).from(profileChangeRequest).where(and(eq(profileChangeRequest.personId,employee.personId),eq(profileChangeRequest.status,'pending'))).orderBy(profileChangeRequest.id);
  expect(rows).toEqual([{id:first.requestId}]);
  expect((await getProfilePhotoProposal(employee.ctx,first.requestId))?.content).toEqual(png);
  expect((await getPersonPhoto(employee.ctx,employee.personId))?.content).toEqual(original);
 });
 it('keeps a concurrent permission closure and approval atomic, with no pending bytes left behind',async()=>{
  const {employee,hr}=await fixture();const {requestId}=await setOwnPersonPhoto(employee.ctx,{employmentId:employee.employmentId,content:png,fileName:'race.png'});
  const [decision,closure]=await Promise.allSettled([
   decideProfileChange(hr.ctx,{requestId,decision:'approved'}),
   saveOwnPhotoSubmissionSetting(group(),{enabled:false,withdrawnReason:'Fictional concurrent closure'}),
  ]);
  expect(closure.status).toBe('fulfilled');
  const [request]=await owner.db.select({status:profileChangeRequest.status,decisionReason:profileChangeRequest.decisionReason}).from(profileChangeRequest).where(eq(profileChangeRequest.id,requestId));
  if(decision.status==='fulfilled'){
   expect(request.status).toBe('approved');expect(closure).toMatchObject({status:'fulfilled',value:{withdrawn:0}});expect((await getPersonPhoto(employee.ctx,employee.personId))?.content).toEqual(png);
  }else{
   expect(decision.reason).toBeInstanceOf(Error);expect(decision.reason.message).toBe('profile change request is already rejected');
   expect(request).toMatchObject({status:'rejected',decisionReason:'Fictional concurrent closure'});expect(closure).toMatchObject({status:'fulfilled',value:{withdrawn:1}});expect((await getPersonPhoto(employee.ctx,employee.personId))?.content).toEqual(original);
  }
  expect(await owner.db.select().from(profilePhotoProposal).where(eq(profilePhotoProposal.requestId,requestId))).toEqual([]);
 });
 it('requires a rejection reason, retains the original master and erases pending bytes while preserving the decision',async()=>{
  const {employee,hr}=await fixture();const {requestId}=await setOwnPersonPhoto(employee.ctx,{employmentId:employee.employmentId,content:png,fileName:'x.png'});
  await expect(decideProfileChange(hr.ctx,{requestId,decision:'rejected'})).rejects.toThrow();
  await decideProfileChange(hr.ctx,{requestId,decision:'rejected',reason:'Fictional image is unclear'});
  expect((await getPersonPhoto(employee.ctx,employee.personId))?.content).toEqual(original);expect(await getProfilePhotoProposal(employee.ctx,requestId)).toBeNull();
  expect((await myProfileChangeRequests(employee.ctx)).find(row=>row.id===requestId)).toMatchObject({status:'rejected',decisionReason:'Fictional image is unclear'});
 });
 it('refuses approval after another HR master-photo change rather than overwriting the newer image',async()=>{
  const {employee,hr}=await fixture();const {requestId}=await setOwnPersonPhoto(employee.ctx,{employmentId:employee.employmentId,content:png,fileName:'x.png'});
  const newer=Buffer.concat([original,Buffer.from([4])]);await setPersonPhoto(group(),{personId:employee.personId,content:newer,fileName:'newer.png',mimeType:'image/png',sizeBytes:newer.length});
  await expect(decideProfileChange(hr.ctx,{requestId,decision:'approved'})).rejects.toMatchObject({code:'stale'});
  expect((await getPersonPhoto(employee.ctx,employee.personId))?.content).toEqual(newer);
 });
 it('preserves the recorded photo reviewer when rules change, without admitting the newly configured reviewer',async()=>{
  const {employee,hr,other}=await fixture();const {requestId}=await setOwnPersonPhoto(employee.ctx,{employmentId:employee.employmentId,content:png,fileName:'x.png'});
  expect(await getProfilePhotoProposal(other.ctx,requestId)).toBeNull();await expect(decideProfileChange(other.ctx,{requestId,decision:'approved'})).rejects.toThrow();
  const [before]=await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,requestId));
  await saveProfileRoutingPolicy(group(),{expectedRevision:before.routeRevision!,enabled:true,rules:[rule(employee.employmentId,other.employmentId)]});
  const [retained]=await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,requestId));
  expect({routeId:retained.routeId,revision:retained.routeRevision,userId:retained.routeApproverUserId,employmentId:retained.routeApproverEmploymentId,context:retained.routeContext,history:retained.routeHistory}).toEqual({routeId:before.routeId,revision:before.routeRevision,userId:before.routeApproverUserId,employmentId:before.routeApproverEmploymentId,context:before.routeContext,history:before.routeHistory});
  expect((await getProfilePhotoProposal(hr.ctx,requestId))?.content).toEqual(png);expect(await getProfilePhotoProposal(other.ctx,requestId)).toBeNull();
  await expect(decideProfileChange(other.ctx,{requestId,decision:'approved'})).rejects.toThrow();
  expect((await getPersonPhoto(employee.ctx,employee.personId))?.content).toEqual(original);
  await decideProfileChange(hr.ctx,{requestId,decision:'approved'});
  expect((await getPersonPhoto(employee.ctx,employee.personId))?.content).toEqual(png);
  expect((await myProfileChangeRequests(employee.ctx)).find(row=>row.id===requestId)?.status).toBe('approved');
 });
 it('changes photo byte access only after explicit rerouting and refuses a revoked replacement reviewer',async()=>{
  const {employee,hr,other}=await fixture();const {requestId}=await setOwnPersonPhoto(employee.ctx,{employmentId:employee.employmentId,content:png,fileName:'x.png'});
  const [before]=await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,requestId));
  await saveProfileRoutingPolicy(group(),{expectedRevision:before.routeRevision!,enabled:true,rules:[rule(employee.employmentId,other.employmentId)]});
  await rerouteProfileRequest(group(),{requestId,reason:'Fictional HR assignment changed'});
  const [rerouted]=await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,requestId));
  expect(rerouted.routeApproverUserId).toBe(other.ctx.userId);expect(rerouted.routeHistory).toEqual([expect.objectContaining({before:expect.objectContaining({approverUserId:hr.ctx.userId}),reason:'Fictional HR assignment changed'})]);
  expect(await getProfilePhotoProposal(hr.ctx,requestId)).toBeNull();await expect(decideProfileChange(hr.ctx,{requestId,decision:'approved'})).rejects.toThrow();
  expect((await getProfilePhotoProposal(other.ctx,requestId))?.content).toEqual(png);
  await owner.db.delete(roleAssignment).where(and(eq(roleAssignment.appUserId,other.ctx.userId!),eq(roleAssignment.role,'hr_admin')));
  expect(await getProfilePhotoProposal(other.ctx,requestId)).toBeNull();await expect(decideProfileChange(other.ctx,{requestId,decision:'approved'})).rejects.toThrow();
  expect((await getPersonPhoto(employee.ctx,employee.personId))?.content).toEqual(original);
  expect((await getProfilePhotoProposal(employee.ctx,requestId))?.content).toEqual(png);
  expect((await myProfileChangeRequests(employee.ctx)).find(row=>row.id===requestId)?.status).toBe('pending');
 });
 it('withdraws and purges pending bytes atomically when the entire Profile tab is hidden',async()=>{
  const {employee}=await fixture();const {requestId}=await setOwnPersonPhoto(employee.ctx,{employmentId:employee.employmentId,content:png,fileName:'x.png'});
  const fields=Object.fromEntries(essVisibleFields().map(field=>[field.id,'viewOnly']));
  const result=await saveProfileVisibilityPolicy(group(),{policy:{version:4,groups:{'tab:Profile':'hide'},fields,primaryOnly:[]},withdrawnReason:'Fictional policy closed'});
  expect(result.withdrawn).toBe(1);expect(await getProfilePhotoProposal(employee.ctx,requestId)).toBeNull();
  expect(await owner.db.select().from(profilePhotoProposal).where(eq(profilePhotoProposal.requestId,requestId))).toEqual([]);
  const [master]=await owner.db.select().from(person).where(eq(person.id,employee.personId));expect(master).toBeTruthy();
  expect(JSON.stringify(await myProfileChangeRequests(employee.ctx))).not.toContain('baselineHash');
 });
 it('withdraws photo proposals when submission is disabled and does not silently accept a missing photo route',async()=>{
  const {employee}=await fixture();const {requestId}=await setOwnPersonPhoto(employee.ctx,{employmentId:employee.employmentId,content:png,fileName:'x.png'});
  expect((await saveOwnPhotoSubmissionSetting(group(),{enabled:false,withdrawnReason:'Fictional submission disabled'})).withdrawn).toBe(1);
  expect(await getProfilePhotoProposal(employee.ctx,requestId)).toBeNull();
  await expect(setOwnPersonPhoto(employee.ctx,{employmentId:employee.employmentId,content:png,fileName:'x.png'})).rejects.toMatchObject({code:'permission'});
 });
 it.each([2,3] as const)('v%s applies the same positive IDs, exclusions and request type at preview, save and submission',async version=>{
  const employee=await worker('Explicitly excluded'),included=await worker('Included'),outside=await worker('Outside positive IDs'),hr=await worker('HR','hr_admin');
  const originalRule=rule(employee.employmentId,hr.employmentId);
  const route={...(version===3?editableProfileRoute(originalRule):originalRule),employmentIds:[employee.employmentId,included.employmentId],excludedEmploymentIds:[employee.employmentId],excludedCriteria:{},requestTypes:['photo' as const]};
  const rules=[route];
  const preview=await previewProfileRoutingPolicy(group(),{version,enabled:true,rules});expect(preview.matched).toBe(1);
  await expect(saveProfileRoutingPolicy(group(),{version,expectedRevision:EMPTY_PROFILE_ROUTING.revision,enabled:true,rules})).rejects.toMatchObject({code:'changed'});
  await saveProfileRoutingPolicy(group(),{version,expectedRevision:EMPTY_PROFILE_ROUTING.revision,enabled:true,rules,previewFingerprint:preview.fingerprint});
  await setTenantSetting(group(),{key:'ess.profile_photo_edit',value:true});
  for(const refused of [employee,outside]){
   await expect(setOwnPersonPhoto(refused.ctx,{employmentId:refused.employmentId,content:png,fileName:'x.png'})).rejects.toMatchObject({code:'missing'});
   expect(await owner.db.select({id:profileChangeRequest.id}).from(profileChangeRequest).where(eq(profileChangeRequest.employmentId,refused.employmentId))).toEqual([]);
  }
  const {requestId}=await setOwnPersonPhoto(included.ctx,{employmentId:included.employmentId,content:png,fileName:'x.png'});expect(requestId).toBeTruthy();
  await expect(submitOwnProfileEdit(included.ctx,{employmentId:included.employmentId,proposal:await proposed(included.ctx,included.employmentId)})).rejects.toMatchObject({code:'missing'});
 });
});

describe('pending photo actual consumer and runtime privilege boundary',()=>{
 it('serves actual bytes only to the subject/current reviewer and returns404 after a decision',async()=>{
  const {employee,hr,other}=await fixture();const {requestId}=await setOwnPersonPhoto(employee.ctx,{employmentId:employee.employmentId,content:png,fileName:'x.png'});
  const read=()=>photoGET(new Request(`http://localhost/me/photo-proposal/${requestId}`),{params:Promise.resolve({requestId})});
  routeSession.current=employee.ctx;const own=await read();expect(own.status).toBe(200);expect(Buffer.from(await own.arrayBuffer())).toEqual(png);expect(own.headers.get('Cache-Control')).toBe('private, no-store');expect(own.headers.get('X-Content-Type-Options')).toBe('nosniff');
  routeSession.current=other.ctx;expect((await read()).status).toBe(404);
  const forged={...other.ctx,personId:employee.personId};
  expect(await getProfilePhotoProposal(forged,requestId)).toBeNull();
  routeSession.current=forged;expect((await read()).status).toBe(404);
  routeSession.current=hr.ctx;expect((await read()).status).toBe(200);
  await decideProfileChange(hr.ctx,{requestId,decision:'rejected',reason:'Fictional refusal'});expect((await read()).status).toBe(404);
 });
 it('denies a real foreign tenant principal rather than relying on a nonexistent UUID',async()=>{
  const {employee,hr}=await fixture();const {requestId}=await setOwnPersonPhoto(employee.ctx,{employmentId:employee.employmentId,content:png,fileName:'x.png'});
  const foreign=await seedBase(),foreignEmployee=await worker('Foreign employee','employee',foreign),foreignHR=await worker('Foreign HR','hr_admin',foreign);
  for(const ctx of [foreignEmployee.ctx,foreignHR.ctx]){expect(await getProfilePhotoProposal(ctx,requestId)).toBeNull();routeSession.current=ctx;expect((await photoGET(new Request(`http://localhost/me/photo-proposal/${requestId}`),{params:Promise.resolve({requestId})})).status).toBe(404);}
  expect((await getProfilePhotoProposal(hr.ctx,requestId))?.content).toEqual(png);
 });
 it('cannot use the retired direct-own-photo GUC or change/delete pending bytes through ai_hr_app',async()=>{
  const {employee}=await fixture();const {requestId}=await setOwnPersonPhoto(employee.ctx,{employmentId:employee.employmentId,content:png,fileName:'x.png'});
  let refusal:unknown;
  const changed=await withTenant(employee.ctx,async tx=>{await tx.execute(sql`select set_config('app.profile_own_photo_write','on',true)`);return tx.update(personPhoto).set({content:png,sizeBytes:png.length}).where(eq(personPhoto.personId,employee.personId)).returning({id:personPhoto.id});}).catch(error=>{refusal=error;return [];});expect(changed).toEqual([]);
  if(refusal){const error=refusal as {code?:string;cause?:{code?:string}};expect(error.code??error.cause?.code).toBe('42501');}
  await expect(withTenant(employee.ctx,tx=>tx.update(profilePhotoProposal).set({content:original,sizeBytes:original.length}).where(eq(profilePhotoProposal.requestId,requestId)))).rejects.toThrow();
  await expect(withTenant(employee.ctx,tx=>tx.delete(profilePhotoProposal).where(eq(profilePhotoProposal.requestId,requestId)))).rejects.toThrow();
  expect((await getPersonPhoto(employee.ctx,employee.personId))?.content).toEqual(original);expect((await getProfilePhotoProposal(employee.ctx,requestId))?.content).toEqual(png);
 });
});
