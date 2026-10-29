import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {setStatutoryProfileMY,setTaxProfileMY} from '../localization/my/statutory';
import {addEmergencyContact,listEmergencyContacts} from '../core/emergency-contacts';
import {listDependents} from '../core/dependents';
import {hireEmployee} from '../core/org';
import {readOwnProfileWorkspace,submitOwnProfileEdit} from '../core/profile-edit';
import {saveProfileVisibilityPolicy} from '../core/profile-edit-policy';
import {decideProfileChange,listProfileChangeRequests} from '../core/profile';
import {previewProfileRoutingPolicy,saveProfileRoutingPolicy} from '../core/profile-routing';
import {listProfileAttachments,readProfileAttachment} from '../core/profile-attachments';
import {essVisibleFields} from '../lib/personnel-ess-contract';
import {editableProfileRoute,EMPTY_PROFILE_ROUTING,type ProfileRouteRule} from '../lib/profile-routing-policy';
import {person,profileChangeRequest,domainEvent,employeeStatutoryMy,personEmergencyContact} from '../db/schema';
import {withTenant,type SessionContext} from '../db/client';
import {migrateTestDb,resetDb,seedBase,owner,adminCtx,createAppUser,closeAll,type Base} from './harness';
let b:Base;
const first='profile.personal_details.firstname',preferred='profile.personal_details.preferredname',phone='profile.contact_and_permanent_address.phone';
const admin=()=>({...adminCtx(b),grants:[{role:'hr_admin' as const,companyId:null}]});
async function subject(role:'employee'|'hr_admin'='employee'){
 const hired=await hireEmployee(admin(),{person:{fullName:'Approval fixture',primaryEmail:`${randomUUID()}@example.test`},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01'});
 const userId=await createAppUser(b.tenantId,hired.personId,role);
 return {...hired,ctx:{...adminCtx(b),userId,personId:hired.personId,roles:[role],grants:[{role,companyId:null}]} satisfies SessionContext};
}
async function policy(approvals:Record<string,{required:boolean;attachmentRequired:boolean}>,closed:Record<string,'hide'|'viewOnly'>={}){
 await saveProfileVisibilityPolicy(admin(),{policy:{version:5,fields:Object.fromEntries(essVisibleFields().map(field=>[field.id,closed[field.id]??(field.ess.binding&&['immediate','approval'].includes(field.ess.edit)?'editable':'viewOnly')])),primaryOnly:[],groups:{},approvals},withdrawnReason:'Fixture policy changed'});
}
async function proposal(s:Awaited<ReturnType<typeof subject>>,values:Record<string,string>){const workspace=await readOwnProfileWorkspace(s.ctx,{employmentId:s.employmentId});return {v:2,fields:Object.entries(values).map(([fieldId,value])=>({fieldId,before:workspace.baselines[fieldId],value})),registers:[]};}
async function route(s:Awaited<ReturnType<typeof subject>>,hrs:Awaited<ReturnType<typeof subject>>[],revision=EMPTY_PROFILE_ROUTING.revision){
 const rule:ProfileRouteRule={...editableProfileRoute({id:randomUUID(),name:'Any eligible HR',approverEmploymentId:hrs[0].employmentId,employmentIds:[s.employmentId],criteria:{}}),approverEmploymentIds:hrs.map(hr=>hr.employmentId)};
 const input={version:3 as const,enabled:true,rules:[rule]},preview=await previewProfileRoutingPolicy(admin(),input);
 return saveProfileRoutingPolicy(admin(),{...input,expectedRevision:revision,previewFingerprint:preview.fingerprint});
}
beforeAll(migrateTestDb);beforeEach(async()=>{await resetDb();b=await seedBase();});afterAll(closeAll);
describe('per-field approval authority',()=>{
 it('directly applies only approval-off editable fields and records explicit mixed outcomes',async()=>{
  const s=await subject();await policy({[first]:{required:false,attachmentRequired:false},[phone]:{required:true,attachmentRequired:false}});
  const result=await submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal:await proposal(s,{[first]:'Direct name',[phone]:'0123456789'})});
  expect(result.saved).toEqual([first]);expect(result.waiting).toEqual([phone]);
  const [master]=await owner.db.select().from(person).where(eq(person.id,s.personId));expect(master.firstName).toBe('Direct name');expect(master.phone).toBeNull();
  await decideProfileChange(admin(),{requestId:result.requestId!,decision:'approved'});
  const [after]=await owner.db.select().from(person).where(eq(person.id,s.personId));expect(after.phone).toBe('0123456789');
 });
 it('uses the canonical bank writer for approval-off fields without granting unrelated statutory changes',async()=>{
  const s=await subject(),bank='bank_statutory.bank_information.bankname',account='bank_statutory.bank_information.bankaccountno';
  await setStatutoryProfileMY(admin(),{personId:s.personId,icNumber:null,bankName:'Maybank',bankAccountNo:'1234567890'});
  await policy({[account]:{required:false,attachmentRequired:false}});
  const result=await submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal:await proposal(s,{[account]:'9876543210'})});expect(result.saved).toEqual([account]);expect(result.requestId).toBeNull();
  expect((await owner.db.select().from(employeeStatutoryMy).where(eq(employeeStatutoryMy.personId,s.personId)))[0]).toMatchObject({bankName:'Maybank',bankAccountNo:'9876543210'});
  await expect(withTenant(s.ctx,async tx=>{await tx.execute(sql`select app.profile_direct_begin(${s.employmentId}::uuid,${JSON.stringify({v:2,fields:[{fieldId:account,value:'1111111111'}],registers:[]})}::jsonb)`);await tx.update(employeeStatutoryMy).set({bankAccountNo:'1111111111',numChildren:99}).where(eq(employeeStatutoryMy.personId,s.personId));})).rejects.toThrow();
 });
 it('reviews a complete new bank pair together when only the account requires approval',async()=>{
  const s=await subject(),bank='bank_statutory.bank_information.bankname',account='bank_statutory.bank_information.bankaccountno';
  await setStatutoryProfileMY(admin(),{personId:s.personId,icNumber:null});
  await policy({[bank]:{required:false,attachmentRequired:false},[account]:{required:true,attachmentRequired:false}});
  const result=await submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal:await proposal(s,{[bank]:'Maybank',[account]:'1234567890'})});
  expect(result.saved).toEqual([]);expect(result.waiting).toEqual([bank,account]);
  expect((await owner.db.select().from(employeeStatutoryMy).where(eq(employeeStatutoryMy.personId,s.personId)))[0]).toMatchObject({bankName:null,bankAccountNo:null});
  await decideProfileChange(admin(),{requestId:result.requestId!,decision:'approved'});
  expect((await owner.db.select().from(employeeStatutoryMy).where(eq(employeeStatutoryMy.personId,s.personId)))[0]).toMatchObject({bankName:'Maybank',bankAccountNo:'1234567890'});
 });
 it('seeds a missing statutory identity row using only canonical fields and installation defaults',async()=>{
  const s=await subject(),oldIc='profile.identity_and_passport.oldicnumber';await policy({[oldIc]:{required:false,attachmentRequired:false}});
  const result=await submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal:await proposal(s,{[oldIc]:'OLD-FIXTURE-100'})});
  expect(result.saved).toEqual([oldIc]);expect((await owner.db.select().from(employeeStatutoryMy).where(eq(employeeStatutoryMy.personId,s.personId)))[0]).toMatchObject({oldIcNumber:'OLD-FIXTURE-100',taxCategory:1,numChildren:0,employerBearsTax:false});
 });
 it('creates a fully approval-off family row through its canonical owner and derives automatic child relief',async()=>{
  const s=await subject(),name='family.family_and_dependents.fullname',relationship='family.family_and_dependents.relationship',dob='family.family_and_dependents.dateofbirth';
  await setStatutoryProfileMY(admin(),{personId:s.personId,icNumber:null});await setTaxProfileMY(admin(),{personId:s.personId,childReliefMode:'auto',numChildren:0});
  await policy(Object.fromEntries([name,relationship,dob].map(id=>[id,{required:false,attachmentRequired:false}])));
  const result=await submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal:{v:2,fields:[],registers:[{kind:'dependent',id:null,clientId:randomUUID(),fields:[{fieldId:name,before:null,value:'Child fixture'},{fieldId:relationship,before:null,value:'child'},{fieldId:dob,before:null,value:'2015-01-01'}]}]}});
  expect(result.waiting).toEqual([]);expect((await listDependents(s.ctx,{personId:s.personId}))).toHaveLength(1);
  expect((await owner.db.select().from(employeeStatutoryMy).where(eq(employeeStatutoryMy.personId,s.personId)))[0].numChildren).toBe(1);
 });
 it('suspends finite primary-only edits for explicit approval-on View Only, retaining old defaults and the Editable approval lane',async()=>{
  const s=await subject(),fieldId='profile.emergency_contact.fullname';
  const contact=await addEmergencyContact(admin(),{personId:s.personId,fullName:'Original primary',priority:'primary'});
  const fields=Object.fromEntries(essVisibleFields().map(field=>[field.id,'viewOnly' as const]));
  await saveProfileVisibilityPolicy(admin(),{policy:{version:5,fields,primaryOnly:[fieldId],groups:{},approvals:{[fieldId]:{required:true,attachmentRequired:true}}},withdrawnReason:'Fixture approval control'});
  const view=await readOwnProfileWorkspace(s.ctx,{employmentId:s.employmentId}),row=view.registers.find(row=>row.id===contact.id)!;
  expect(view.legacyPrimaryEditable).not.toContain(fieldId);
  const proposed={v:2,fields:[],registers:[{kind:'emergency',id:contact.id,clientId:contact.id,fields:[{fieldId,before:row.baselines[fieldId],value:'Unapproved change'}]}]};
  await expect(submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal:proposed})).rejects.toMatchObject({code:'fieldClosed'});
  await expect(withTenant(s.ctx,async tx=>{await tx.update(personEmergencyContact).set({fullName:'Raw bypass'}).where(eq(personEmergencyContact.id,contact.id));})).rejects.toThrow();
  expect((await listEmergencyContacts(s.ctx,{personId:s.personId})).find(row=>row.id===contact.id)?.fullName).toBe('Original primary');
  await saveProfileVisibilityPolicy(admin(),{policy:{version:4,fields,primaryOnly:[fieldId],groups:{}},withdrawnReason:'Legacy fixture'});
  const legacy=await submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal:proposed});expect(legacy.saved).toEqual([fieldId]);expect(legacy.requestId).toBeNull();
  await policy({[fieldId]:{required:true,attachmentRequired:true}});
  const editable=await readOwnProfileWorkspace(s.ctx,{employmentId:s.employmentId}),current=editable.registers.find(row=>row.id===contact.id)!;
  const requested={...proposed,registers:[{...proposed.registers[0],fields:[{fieldId,before:current.baselines[fieldId],value:'Approved primary'}]}]};
  await expect(submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal:requested})).rejects.toMatchObject({code:'attachmentRequired'});
  const result=await submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal:requested,attachments:[{fieldIds:[fieldId],fileName:'support.pdf',mimeType:'application/pdf',contentBase64:Buffer.from('%PDF-fixture').toString('base64')}]});
  expect(result.saved).toEqual([]);expect(result.waiting).toEqual([fieldId]);
  expect((await listEmergencyContacts(s.ctx,{personId:s.personId})).find(row=>row.id===contact.id)?.fullName).toBe('Unapproved change');
  await decideProfileChange(admin(),{requestId:result.requestId!,decision:'approved'});
  expect((await listEmergencyContacts(s.ctx,{personId:s.personId})).find(row=>row.id===contact.id)?.fullName).toBe('Approved primary');
 });
 it('keeps hidden and read-only upper bounds even when approvals are disabled',async()=>{
  const s=await subject();await policy({[first]:{required:false,attachmentRequired:false},[preferred]:{required:false,attachmentRequired:false}},{[first]:'hide',[preferred]:'viewOnly'});
  for(const fieldId of [first,preferred])await expect(submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal:{v:2,fields:[{fieldId,before:null,value:'Forbidden'}],registers:[]}})).rejects.toThrow();
 });
 it('refuses raw direct updates without exact intent and an actual audit witness',async()=>{
  const s=await subject();await policy({[first]:{required:false,attachmentRequired:false}});
  await expect(withTenant(s.ctx,tx=>tx.update(person).set({firstName:'Forged'}).where(eq(person.id,s.personId)))).rejects.toThrow();
  await expect(withTenant(s.ctx,async tx=>{await tx.execute(sql`select app.profile_direct_begin(${s.employmentId}::uuid,${JSON.stringify({v:2,fields:[{fieldId:first,value:'Forged'}],registers:[]})}::jsonb)`);await tx.update(person).set({firstName:'Forged'}).where(eq(person.id,s.personId));})).rejects.toThrow();
  expect((await owner.db.select().from(person).where(eq(person.id,s.personId)))[0].firstName).toBeNull();
 });
 it('keeps authorization evidence private and refuses incomplete transactions without retaining proposed values',async()=>{
  const s=await subject();await policy({[first]:{required:false,attachmentRequired:false}});
  const privileges=await owner.db.execute<{allowed:boolean}>(sql`select has_table_privilege('ai_hr_app','app.profile_direct_intent','SELECT') or has_table_privilege('ai_hr_app','app.profile_direct_family_delta','INSERT') as allowed`);expect(privileges[0].allowed).toBe(false);
  await expect(withTenant(s.ctx,tx=>tx.execute(sql`select app.profile_direct_begin(${s.employmentId}::uuid,${JSON.stringify({v:2,fields:[{fieldId:first,value:'Unused private value'}],registers:[]})}::jsonb)`))).rejects.toThrow();
  const remaining=await owner.db.execute<{count:number}>(sql`select count(*)::integer as count from app.profile_direct_intent where tenant_id=${b.tenantId}::uuid`);expect(remaining[0].count).toBe(0);
 });
 it('requires documents only for the configured fields and retains private evidence on exact retries',async()=>{
  const s=await subject(),other=await subject();await policy({[first]:{required:true,attachmentRequired:true}});const proposed=await proposal(s,{[first]:'With evidence'});
  await expect(submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal:proposed})).rejects.toMatchObject({code:'attachmentRequired'});
  const attachment={fieldIds:[first],fileName:'support.pdf',mimeType:'application/pdf' as const,contentBase64:Buffer.from('%PDF-1.7\nevidence').toString('base64')};
  const result=await submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal:proposed,attachments:[attachment]});
  expect((await submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal:proposed,attachments:[attachment]})).requestId).toBe(result.requestId);
  await expect(submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal:proposed,attachments:[{...attachment,fileName:'other.pdf'}]})).rejects.toMatchObject({code:'stale'});
  const files=await listProfileAttachments(s.ctx,result.requestId!);expect(files).toHaveLength(1);expect((await readProfileAttachment(s.ctx,files[0].id)).content.toString()).toContain('evidence');
  await expect(readProfileAttachment(other.ctx,files[0].id)).rejects.toThrow();
  await decideProfileChange(admin(),{requestId:result.requestId!,decision:'approved'});
 });
});
describe('immutable any-one HR snapshots',()=>{
 it('lets either eligible HR see the request, preserves the original snapshot across configuration saves, and serializes concurrent decisions',async()=>{
  const s=await subject(),a=await subject('hr_admin'),bhr=await subject('hr_admin'),other=await subject('hr_admin');
  await policy({});const saved=await route(s,[a,bhr]);
  const result=await submitOwnProfileEdit(s.ctx,{employmentId:s.employmentId,proposal:await proposal(s,{[first]:'Any one'})});
  for(const hr of [a,bhr])expect((await listProfileChangeRequests(hr.ctx,{status:'pending'})).map(row=>row.id)).toContain(result.requestId);
  expect(await listProfileChangeRequests(other.ctx,{status:'pending'})).toHaveLength(0);
  await route(s,[other],saved.revision);
  await owner.db.execute(sql`update profile_change_request set route_context=jsonb_set(route_context,'{asOf}','"2020-01-01"'::jsonb) where id=${result.requestId!}::uuid`);
  await expect(decideProfileChange(other.ctx,{requestId:result.requestId!,decision:'approved'})).rejects.toThrow();
  const outcomes=await Promise.allSettled([decideProfileChange(a.ctx,{requestId:result.requestId!,decision:'approved'}),decideProfileChange(bhr.ctx,{requestId:result.requestId!,decision:'rejected',reason:'Evidence needs correction'})]);
  expect(outcomes.filter(outcome=>outcome.status==='fulfilled')).toHaveLength(1);
  expect(['approved','rejected']).toContain((await owner.db.select().from(profileChangeRequest).where(eq(profileChangeRequest.id,result.requestId!)))[0].status);
  expect(await listProfileChangeRequests(bhr.ctx,{status:'pending'})).toHaveLength(0);
  const events=await owner.db.select().from(domainEvent).where(eq(domainEvent.aggregateId,result.requestId!));expect(events.filter(event=>['profile-change.approved','profile-change.rejected'].includes(event.eventType))).toHaveLength(1);
 });
});
