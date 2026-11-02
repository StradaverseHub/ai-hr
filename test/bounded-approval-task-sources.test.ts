/** Exact assigned work remains actionable without restoring general employee/person/ledger access. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee,setReportingLine} from '../core/org';
import {readOwnProfileWorkspace,submitOwnProfileEdit} from '../core/profile-edit';
import {saveProfileVisibilityPolicy} from '../core/profile-edit-policy';
import {decideProfileChange,listProfileChangeRequests,pendingProfileTaskMetadata} from '../core/profile';
import {previewProfileRoutingPolicy,saveProfileRoutingPolicy,profileRouteCounts} from '../core/profile-routing';
import {addDependent} from '../core/dependents';
import {setTenantSetting} from '../core/tenant-settings';
import {setOwnPersonPhoto,getPersonPhoto} from '../core/person-photo';
import {decideLeave} from '../core/leave';
import {listLeaveRequests} from '../core/read';
import {essVisibleFields} from '../lib/personnel-ess-contract';
import {editableProfileRoute,EMPTY_PROFILE_ROUTING,type ProfileRouteRule} from '../lib/profile-routing-policy';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,root:SessionContext;
const phone='profile.contact_and_permanent_address.phone';
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(async()=>{await resetDb();b=await seedBase();root={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};});
async function employee(code:string,role:'employee'|'hr_admin'|'manager'='employee'){
 const hire=await hireEmployee(root,{person:{fullName:'Fictional '+code,primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2024-01-01',employeeCode:code});
 const userId=await createAppUser(b.tenantId,hire.personId,role);
 if(role==='hr_admin')await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,userId));
 return{...hire,ctx:{...adminCtx(b),userId,personId:hire.personId,roles:[role],grants:[{role,companyId:role==='hr_admin'?b.companyId:null}]} as SessionContext};
}
async function restrict(actor:Awaited<ReturnType<typeof employee>>,code:string){const id=randomUUID(),rev=randomUUID();await owner.client`insert into data_permission_profile(id,tenant_id,name)values(${id},${b.tenantId},${'Task scope '+id})`;await owner.client`insert into data_permission_revision(id,tenant_id,profile_id,rules,created_by)values(${rev},${b.tenantId},${id},${JSON.stringify({legacyCompany:false,predicates:[{field:'employeeId',values:[code]}]})}::jsonb,${root.userId!})`;await owner.client`update data_permission_profile set enabled=true,active_revision_id=${rev} where id=${id}`;await owner.client`insert into user_data_permission_assignment(tenant_id,user_id,profile_id,assigned_by)values(${b.tenantId},${actor.ctx.userId!},${id},${root.userId!})`;}
async function phoneRequest(field=phone,value="0123456789"){
 const subject=await employee('TASK-SUBJECT'),approver=await employee('TASK-APPROVER','hr_admin'),outsider=await employee('TASK-OUTSIDER','hr_admin');
 await saveProfileVisibilityPolicy(root,{policy:{version:5,fields:Object.fromEntries(essVisibleFields().map(field=>[field.id,field.ess.binding&&['immediate','approval'].includes(field.ess.edit)?'editable':'viewOnly'])),primaryOnly:[],groups:{},approvals:{[field]:{required:true,attachmentRequired:false}}},withdrawnReason:'Fixture policy'});
 const rule:ProfileRouteRule={...editableProfileRoute({id:randomUUID(),name:'Exact HR task',approverEmploymentId:approver.employmentId,employmentIds:[subject.employmentId],criteria:{}}),approverEmploymentIds:[approver.employmentId]},input={version:3 as const,enabled:true,rules:[rule]},preview=await previewProfileRoutingPolicy(root,input);await saveProfileRoutingPolicy(root,{...input,expectedRevision:EMPTY_PROFILE_ROUTING.revision,previewFingerprint:preview.fingerprint});
 await owner.db.insert(s.employeeStatutoryMy).values({tenantId:b.tenantId,personId:subject.personId,bankName:"Fixture bank",bankAccountNo:"123456789"});
 const workspace=await readOwnProfileWorkspace(subject.ctx,{employmentId:subject.employmentId}),result=await submitOwnProfileEdit(subject.ctx,{employmentId:subject.employmentId,proposal:{v:2,fields:[{fieldId:field,before:workspace.baselines[field],value}],registers:[]}});expect(result.requestId).toBeTruthy();await restrict(approver,'TASK-APPROVER');await restrict(outsider,'TASK-OUTSIDER');return{subject,approver,outsider,id:result.requestId!};
}
async function noRaw(actor:SessionContext,subject:{employmentId:string;personId:string}){await withTenant(actor,async tx=>{expect(await tx.select().from(s.employment).where(eq(s.employment.id,subject.employmentId))).toEqual([]);expect(await tx.select().from(s.person).where(eq(s.person.id,subject.personId))).toEqual([]);});}
it('lists and applies an exact named phone approval while unrelated raw facts remain hidden',async()=>{
 const {subject,approver,outsider,id}=await phoneRequest();await noRaw(approver.ctx,subject);
 const queue=await listProfileChangeRequests(approver.ctx,{requestId:id});expect(queue).toHaveLength(1);expect(queue[0].employee).toBe('Fictional TASK-SUBJECT');expect(queue[0].review[phone].value).toBeNull();expect((await pendingProfileTaskMetadata(approver.ctx)).map(row=>row.id)).toContain(id);expect((await profileRouteCounts(approver.ctx)).pending).toBe(1);
 const [source]=await withTenant(approver.ctx,tx=>tx.execute<{value:{master:Record<string,unknown>}}>(sql`select app.profile_task_projection(${id}::uuid,false) as value`));expect(Object.keys(source.value.master).sort()).toEqual(['id','phone','tenantId']);
 expect(await listProfileChangeRequests(outsider.ctx,{requestId:id})).toEqual([]);await expect(withTenant(outsider.ctx,tx=>tx.execute(sql`select app.profile_task_projection(${id}::uuid,false)`))).rejects.toThrow();
 await decideProfileChange(approver.ctx,{requestId:id,decision:'approved'});expect((await owner.db.select({phone:s.person.phone}).from(s.person).where(eq(s.person.id,subject.personId)))[0].phone).toBe('0123456789');await noRaw(approver.ctx,subject);
});
it('rejects stale approved source values and allows a scoped assignee to record an explicit rejection',async()=>{
 const {subject,approver,id}=await phoneRequest();await owner.db.update(s.person).set({phone:'PRIVATE newer value'}).where(eq(s.person.id,subject.personId));await expect(decideProfileChange(approver.ctx,{requestId:id,decision:'approved'})).rejects.toThrow();expect((await owner.db.select().from(s.profileChangeRequest).where(eq(s.profileChangeRequest.id,id)))[0].status).toBe('pending');await decideProfileChange(approver.ctx,{requestId:id,decision:'rejected',reason:'Please submit current details'});expect((await owner.db.select().from(s.person).where(eq(s.person.id,subject.personId)))[0].phone).toBe('PRIVATE newer value');
});
it('never turns task preparation into arbitrary fields, a different person, or an unaudited persistent write',async()=>{
 const {subject,approver,id}=await phoneRequest();const [before]=await owner.db.select().from(s.person).where(eq(s.person.id,subject.personId));
 await expect(withTenant(approver.ctx,async tx=>{await tx.execute(sql`select app.profile_task_projection(${id}::uuid,true)`);await tx.execute(sql`select app.profile_task_store_person(${subject.personId}::uuid,'{"nationality":"Singaporean"}'::jsonb)`);})).rejects.toThrow();
 await expect(withTenant(approver.ctx,async tx=>{await tx.execute(sql`select app.profile_task_projection(${id}::uuid,true)`);await tx.execute(sql`select app.profile_task_store_person(${subject.personId}::uuid,'{"phone":"0123456789"}'::jsonb)`);})).rejects.toThrow();expect((await owner.db.select().from(s.person).where(eq(s.person.id,subject.personId)))[0]).toEqual(before);
});
it('uses the actual request balance for a manager decision while keeping the raw ledger hidden',async()=>{
 const subject=await employee('LEAVE-SUBJECT'),manager=await employee('LEAVE-MANAGER','manager');await setReportingLine(root,{subordinateEmploymentId:subject.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2024-01-01'});
 await owner.db.insert(s.leaveLedger).values({tenantId:b.tenantId,employmentId:subject.employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual',days:'10.00',effectiveOn:'2026-01-01'});
 const date=todayInKualaLumpur(),[request]=await owner.db.insert(s.leaveRequest).values({tenantId:b.tenantId,employmentId:subject.employmentId,leaveTypeId:b.annualLeaveTypeId,startDate:date,endDate:date,days:'1.00',status:'pending'}).returning();await restrict(manager,'LEAVE-MANAGER');await noRaw(manager.ctx,subject);
 expect(await withTenant(manager.ctx,tx=>tx.select().from(s.leaveLedger).where(eq(s.leaveLedger.employmentId,subject.employmentId)))).toEqual([]);expect((await listLeaveRequests(manager.ctx,undefined,20,{requestId:request.id})).map(row=>row.id)).toEqual([request.id]);
 const unrelated=await employee('LEAVE-NO-TASK');await setReportingLine(root,{subordinateEmploymentId:unrelated.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2024-01-01'});expect(await withTenant(manager.ctx,tx=>tx.execute(sql`select * from app.delegated_approval_subject(${unrelated.employmentId}::uuid,'leave','leave.application')`))).toEqual([]);
 const [balance]=await withTenant(manager.ctx,tx=>tx.execute<{value:string}>(sql`select app.leave_task_balance(${request.id}::uuid,${b.annualLeaveTypeId}::uuid) as value`));expect(Number(balance.value)).toBe(10);await decideLeave(manager.ctx,{leaveRequestId:request.id,decision:'approved',deciderEmploymentId:manager.employmentId});const [after]=await owner.client`select sum(days)::text as value from leave_ledger where employment_id=${subject.employmentId} and leave_type_id=${b.annualLeaveTypeId}`;expect(Number(after.value)).toBe(9);await noRaw(manager.ctx,subject);
});

it('applies an exact assigned bank correction without exposing identity or sibling statutory fields',async()=>{
 const bank='bank_statutory.bank_information.bankname';const {subject,approver,id}=await phoneRequest(bank,'Maybank');
 await decideProfileChange(approver.ctx,{requestId:id,decision:'approved'});
 const [row]=await owner.db.select().from(s.employeeStatutoryMy).where(eq(s.employeeStatutoryMy.personId,subject.personId));expect(row.bankName).toBe('Maybank');expect(row.bankAccountNo).toBe('123456789');await noRaw(approver.ctx,subject);
});

it('applies only the selected dependent correction through the native register validator',async()=>{
 const {subject,approver,id}=await phoneRequest();await decideProfileChange(approver.ctx,{requestId:id,decision:'rejected',reason:'Register fixture'});
 const child=await addDependent(root,{personId:subject.personId,fullName:'Fictional child',relationship:'child'}),sibling=await addDependent(root,{personId:subject.personId,fullName:'Unrelated family',relationship:'parent'}),field='family.family_and_dependents.fullname';
 const view=await readOwnProfileWorkspace(subject.ctx,{employmentId:subject.employmentId}),record=view.registers.find(row=>row.id===child.id)!;
 const submitted=await submitOwnProfileEdit(subject.ctx,{employmentId:subject.employmentId,proposal:{v:2,fields:[],registers:[{kind:'dependent',id:child.id,clientId:child.id,fields:[{fieldId:field,before:record.baselines[field],value:'Fictional corrected child'}]}]}});expect(submitted.requestId).toBeTruthy();
 await expect(withTenant(approver.ctx,async tx=>{await tx.execute(sql`select app.profile_task_projection(${submitted.requestId}::uuid,true)`);await tx.execute(sql`select app.profile_task_store_register(${subject.personId}::uuid,'dependent',${sibling.id}::uuid,${sibling.id},'{"fullName":"Forged sibling"}'::jsonb)`);})).rejects.toThrow();
 await expect(withTenant(approver.ctx,async tx=>{await tx.execute(sql`select app.profile_task_projection(${submitted.requestId}::uuid,true)`);await tx.execute(sql`select app.profile_task_store_register(${subject.personId}::uuid,'dependent',${child.id}::uuid,${child.id},'{"fullName":"Different unauthorized name"}'::jsonb)`);await decideProfileChange(approver.ctx,{requestId:submitted.requestId!,decision:'approved'},tx);})).rejects.toThrow();
 await decideProfileChange(approver.ctx,{requestId:submitted.requestId!,decision:'approved'});
 const rows=await owner.db.select().from(s.employeeDependent);expect(rows.find(row=>row.id===child.id)?.fullName).toBe('Fictional corrected child');expect(rows.find(row=>row.id===sibling.id)?.fullName).toBe('Unrelated family');await noRaw(approver.ctx,subject);
});
it('applies exact stored photo bytes for its named task while keeping the master photo hidden',async()=>{
 const {subject,approver,id}=await phoneRequest();await decideProfileChange(approver.ctx,{requestId:id,decision:'rejected',reason:'Photo fixture'});await setTenantSetting(root,{key:'ess.profile_photo_edit',value:true});
 const png=Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082','hex');
 const submitted=await setOwnPersonPhoto(subject.ctx,{employmentId:subject.employmentId,content:png,fileName:'fictional.png'});
 await expect(withTenant(approver.ctx,tx=>tx.execute(sql`select app.profile_task_store_photo(${submitted.requestId}::uuid)`))).rejects.toThrow();
 await expect(withTenant(approver.ctx,async tx=>{await tx.execute(sql`set constraints all immediate`);await tx.execute(sql`select app.profile_task_store_photo(${submitted.requestId}::uuid)`);})).rejects.toThrow();
 await decideProfileChange(approver.ctx,{requestId:submitted.requestId,decision:'approved'});
 expect((await owner.db.select().from(s.personPhoto).where(eq(s.personPhoto.personId,subject.personId)))[0].content).toEqual(png);expect(await getPersonPhoto(approver.ctx,subject.personId)).toBeNull();await noRaw(approver.ctx,subject);
});
