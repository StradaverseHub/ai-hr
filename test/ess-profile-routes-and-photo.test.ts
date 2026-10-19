/** Source-prepared integration journeys. Run only in an explicitly granted test/DB window. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq} from 'drizzle-orm';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import type {SessionContext} from '../db/client';
import {hireEmployee} from '../core/org';
import {readOwnProfileWorkspace,submitOwnProfileEdit} from '../core/profile-edit';
import {readOwnProfileFacts} from '../core/profile-view';
import {listProfileChangeRequests,decideProfileChange,myProfileChangeRequests} from '../core/profile';
import {saveProfileRoutingPolicy,rerouteProfileRequest,profileRouteCounts,profileRerouteCandidates} from '../core/profile-routing';
import {EMPTY_PROFILE_ROUTING,type ProfileRouteRule} from '../lib/profile-routing-policy';
import {setTenantSetting} from '../core/tenant-settings';
import {essVisibleFields} from '../lib/personnel-ess-contract';
import {saveProfileVisibilityPolicy} from '../core/profile-edit-policy';
import {setOwnPersonPhoto,removePersonPhoto,getPersonPhoto} from '../core/person-photo';
import {person,profileChangeRequest,roleAssignment} from '../db/schema';
let b:Base;
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
const group=():SessionContext=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]});
async function worker(name:string,role:'employee'|'hr_admin'='employee'){
 const hired=await hireEmployee(group(),{person:{fullName:name,primaryEmail:`${randomUUID()}@example.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 const userId=await createAppUser(b.tenantId,hired.personId,role);
 return {...hired,ctx:{...adminCtx(b),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]} satisfies SessionContext};
}
function rule(subject:string,approver:string):ProfileRouteRule{return {id:randomUUID(),name:'Named HR fixture',approverEmploymentId:approver,employmentIds:[subject],criteria:{}};}
async function proposed(ctx:SessionContext,employmentId:string,includePhone=false){
 const workspace=await readOwnProfileWorkspace(ctx,{employmentId});
 return {v:2,fields:[{fieldId:'profile.personal_details.firstname',before:workspace.baselines['profile.personal_details.firstname'],value:'Requested name'},...(includePhone?[{fieldId:'profile.contact_and_permanent_address.phone',before:workspace.baselines['profile.contact_and_permanent_address.phone'],value:'0123456789'}]:[])],registers:[]};
}
describe('named profile routing against real request/organisation owners',()=>{
 it('freezes a stable HR identity, narrows queue and counts, and retains the employee request status',async()=>{
  const employee=await worker('Subject'),hr=await worker('Assigned HR','hr_admin'),other=await worker('Other HR','hr_admin');
  const route=rule(employee.employmentId,hr.employmentId);
  const saved=await saveProfileRoutingPolicy(group(),{expectedRevision:EMPTY_PROFILE_ROUTING.revision,enabled:true,rules:[route]});
  const result=await submitOwnProfileEdit(employee.ctx,{employmentId:employee.employmentId,proposal:await proposed(employee.ctx,employee.employmentId)});
  expect(result.requestId).toBeTruthy();
  const [stored]=await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,result.requestId!));
  expect(stored.routeId).toBe(route.id);expect(stored.routeRevision).toBe(saved.revision);expect(stored.routeApproverUserId).toBe(hr.ctx.userId);
  expect((await listProfileChangeRequests(hr.ctx,{status:'pending'})).map(row=>row.id)).toContain(result.requestId);
  expect(await listProfileChangeRequests(other.ctx,{status:'pending'})).toEqual([]);
  expect((await profileRouteCounts(other.ctx)).pending).toBe(0);
  await expect(decideProfileChange(other.ctx,{requestId:result.requestId!,decision:'approved'})).rejects.toThrow();
  await decideProfileChange(hr.ctx,{requestId:result.requestId!,decision:'approved'});
  expect((await myProfileChangeRequests(employee.ctx)).find(row=>row.id===result.requestId)?.status).toBe('approved');
 });
 it('rolls back immediate edits when the same submission has no matching route',async()=>{
  const employee=await worker('Missing subject'),covered=await worker('Covered subject'),hr=await worker('HR','hr_admin');
  await saveProfileRoutingPolicy(group(),{expectedRevision:EMPTY_PROFILE_ROUTING.revision,enabled:true,rules:[rule(covered.employmentId,hr.employmentId)]});
  const [before]=await owner.db.select({phone:person.phone}).from(person).where(eq(person.id,employee.personId));
  await expect(submitOwnProfileEdit(employee.ctx,{employmentId:employee.employmentId,proposal:await proposed(employee.ctx,employee.employmentId,true)})).rejects.toMatchObject({code:'missing'});
  const [after]=await owner.db.select({phone:person.phone}).from(person).where(eq(person.id,employee.personId));expect(after).toEqual(before);
  expect(await owner.db.select({id:profileChangeRequest.id}).from(profileChangeRequest).where(eq(profileChangeRequest.personId,employee.personId))).toEqual([]);
 });
 it('requires explicit reasoned rerouting after revision changes and keeps the original route history',async()=>{
  const employee=await worker('Subject'),hr=await worker('HR one','hr_admin'),replacement=await worker('HR two','hr_admin');
  const route=rule(employee.employmentId,hr.employmentId);
  const first=await saveProfileRoutingPolicy(group(),{expectedRevision:EMPTY_PROFILE_ROUTING.revision,enabled:true,rules:[route]});
  const submitted=await submitOwnProfileEdit(employee.ctx,{employmentId:employee.employmentId,proposal:await proposed(employee.ctx,employee.employmentId)});
  await saveProfileRoutingPolicy(group(),{expectedRevision:first.revision,enabled:true,rules:[{...route,approverEmploymentId:replacement.employmentId}]});
  await expect(decideProfileChange(hr.ctx,{requestId:submitted.requestId!,decision:'approved'})).rejects.toThrow();
  await expect(Promise.resolve().then(()=>rerouteProfileRequest(group(),{requestId:submitted.requestId!,reason:''}))).rejects.toMatchObject({code:'reasonRequired'});
  await rerouteProfileRequest(group(),{requestId:submitted.requestId!,reason:'Fictional responsibility change'});
  const [stored]=await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,submitted.requestId!));
  expect(stored.routeApproverUserId).toBe(replacement.ctx.userId);expect(stored.routeHistory).toEqual([expect.objectContaining({before:expect.objectContaining({approverUserId:hr.ctx.userId}),reason:'Fictional responsibility change'})]);
  await decideProfileChange(replacement.ctx,{requestId:submitted.requestId!,decision:'approved'});
 });
 it('refuses a removed HR grant at decision and prevents overlapping or self routes',async()=>{
  const employee=await worker('Subject'),hr=await worker('HR','hr_admin'),route=rule(employee.employmentId,hr.employmentId);
  await expect(saveProfileRoutingPolicy(group(),{expectedRevision:EMPTY_PROFILE_ROUTING.revision,enabled:true,rules:[route,{...route,id:randomUUID()}]})).rejects.toMatchObject({code:'overlap'});
  await expect(saveProfileRoutingPolicy(group(),{expectedRevision:EMPTY_PROFILE_ROUTING.revision,enabled:true,rules:[rule(hr.employmentId,hr.employmentId)]})).rejects.toMatchObject({code:'unauthorized'});
  await saveProfileRoutingPolicy(group(),{expectedRevision:EMPTY_PROFILE_ROUTING.revision,enabled:true,rules:[route]});
  const submitted=await submitOwnProfileEdit(employee.ctx,{employmentId:employee.employmentId,proposal:await proposed(employee.ctx,employee.employmentId)});
  await owner.db.delete(roleAssignment).where(and(eq(roleAssignment.appUserId,hr.ctx.userId!),eq(roleAssignment.role,'hr_admin')));
  await expect(decideProfileChange(hr.ctx,{requestId:submitted.requestId!,decision:'approved'})).rejects.toThrow();
  const [stored]=await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,submitted.requestId!));expect(stored.status).toBe('pending');
 });
});
describe('bounded private maintenance picker',()=>{
 it('keeps every request reachable across explicit cursor pages without returning proposed values',async()=>{
  const employee=await worker('Paging subject');
  const created=Date.now()-120000;
  await owner.db.insert(profileChangeRequest).values(Array.from({length:53},(_,ordinal)=>({tenantId:b.tenantId,employmentId:employee.employmentId,personId:employee.personId,proposed:{private:'NEVER IN PICKER'},createdAt:new Date(created+ordinal)})));
  const first=await profileRerouteCandidates(group(),{query:'Paging subject'});
  expect(first.rows).toHaveLength(50);expect(first.nextCursor).not.toBeNull();
  const second=await profileRerouteCandidates(group(),{query:'Paging subject',after:first.nextCursor!});
  expect(second.rows).toHaveLength(3);expect(second.nextCursor).toBeNull();
  expect(new Set([...first.rows,...second.rows].map(row=>row.id)).size).toBe(53);
  expect(JSON.stringify({first,second})).not.toContain('NEVER IN PICKER');
  expect(Object.keys(first.rows[0]).sort()).toEqual(['createdAt','employeeCode','id','name']);
 });
});
describe('independent own photo and hidden payloads',()=>{
 const png=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]);
 it('defaults photo editing off, enables only own upload, and keeps deletion as HR authority',async()=>{
  const employee=await worker('Photo subject'),other=await worker('Other subject');
  await expect(setOwnPersonPhoto(employee.ctx,{employmentId:employee.employmentId,content:png,fileName:'test.png'})).rejects.toThrow();
  await setTenantSetting(group(),{key:'ess.profile_photo_edit',value:true});
  await setOwnPersonPhoto(employee.ctx,{employmentId:employee.employmentId,content:png,fileName:'test.png'});
  expect((await getPersonPhoto(employee.ctx,employee.personId))?.content.equals(png)).toBe(true);
  await expect(setOwnPersonPhoto(employee.ctx,{employmentId:other.employmentId,content:png,fileName:'test.png'})).rejects.toThrow();
  await expect(Promise.resolve().then(()=>setOwnPersonPhoto(employee.ctx,{employmentId:employee.employmentId,content:Buffer.from('not a photo'),fileName:'test.png'}))).rejects.toThrow();
  await expect(removePersonPhoto(employee.ctx,{personId:employee.personId})).rejects.toThrow();
 });
 it('strips hidden facts, values, choices, baselines, headers and request lines at the server boundary',async()=>{
  const employee=await worker('PRIVATE PROFILE NAME');
  const fields=Object.fromEntries(essVisibleFields().map(field=>[field.id,'viewOnly']));
  for(const id of ['profile.personal_details.fullname','profile.personal_details.firstname','profile.personal_details.dateofbirth','profile.personal_details.photo','employment.organisation_assignment.companyname'])fields[id]='hide';
  await saveProfileVisibilityPolicy(group(),{policy:{version:3,fields,primaryOnly:[]},withdrawnReason:'Fictional policy closure'});
  const workspace=await readOwnProfileWorkspace(employee.ctx,{employmentId:employee.employmentId}),facts=await readOwnProfileFacts(employee.ctx,employee.employmentId);
  expect(JSON.stringify({workspace,facts})).not.toContain('PRIVATE PROFILE NAME');
  expect(workspace.baselines).not.toHaveProperty('profile.personal_details.fullname');expect(facts.header.name).toBe('');expect(facts.header.company).toBeNull();
  expect(facts.values).not.toHaveProperty('employment.organisation_assignment.companyname');
 });
});
