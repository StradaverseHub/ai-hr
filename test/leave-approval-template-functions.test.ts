/** Exact template-native courses and storage-owner publication. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import {publishActionCapabilityPackage} from '../deploy/access/publish-workforce-capabilities';
import * as s from '../db/schema';
import {assignApprovalTemplate,previewApprovalTemplateAssignment,unassignApprovalTemplate,createApprovalTemplate,updateApprovalTemplate,duplicateApprovalTemplate,setApprovalTemplateActive,setTenantDefaultTemplate,deleteApprovalTemplate,listApprovalTemplates,listApprovalTemplatesForMaintenance,approvalTemplateActionAccess} from '../core/leave-approval-template';
import {getLeaveEscalationPolicy,getLeaveEscalationPolicyForMaintenance,setLeaveEscalationPolicy,resolveApprovalChain} from '../core/leave-approval-policy';
import {leaveApprovalCompanyAccess} from '../core/leave-approval-action-access';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let b:Base,admin:SessionContext,companyHr:SessionContext,member:SessionContext;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{
 await resetDb();b=await seedBase();admin=adminCtx(b);
 const hr=await createAppUser(b.tenantId,null,'hr_admin');await owner.db.update(s.roleAssignment).set({companyId:b.companyId}).where(eq(s.roleAssignment.appUserId,hr));
 companyHr={...admin,userId:hr,personId:null,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
 const userId=await createAppUser(b.tenantId,null,'employee');member={...admin,userId,personId:null,roles:['employee'],grants:[{role:'employee',companyId:null}]};
});
async function rawRefusal(run:Promise<unknown>){
 let failure:unknown;try{await run;}catch(error){failure=error;}let denied=false;
 for(let cause=failure;cause&&typeof cause==='object';cause=(cause as {cause?:unknown}).cause)if((cause as {code?:string}).code==='42501'&&(cause as {message?:string}).message==='Leave approval template action unavailable')denied=true;
 expect(denied).toBe(true);
}
it('retains actual company-HR template construction independently of the group-only Leave Types floor',async()=>{
 const [native]=await withTenant(companyHr,tx=>tx.execute<{anyHr:boolean;groupHr:boolean}>(sql`select app.is_admin() as "anyHr",app.is_group_admin() as "groupHr"`));expect(native).toEqual({anyHr:true,groupHr:false});
 expect(await Promise.all((['view','add','edit','delete'] as const).map(operation=>approvalTemplateActionAccess(companyHr,operation)))).toEqual([true,true,true,true]);
 const template=await createApprovalTemplate(companyHr,{name:'Fictional scoped HR template',levels:['direct_manager']});
 await updateApprovalTemplate(companyHr,template.id,{name:'Fictional scoped HR revised',levels:['hr_admin']});
 const duplicate=await duplicateApprovalTemplate(companyHr,template.id);await setApprovalTemplateActive(companyHr,duplicate.id,false);await setApprovalTemplateActive(companyHr,duplicate.id,true);await deleteApprovalTemplate(companyHr,duplicate.id);
 await setTenantDefaultTemplate(companyHr,template.id);expect(await withTenant(member,tx=>resolveApprovalChain(tx,b.companyId,b.annualLeaveTypeId))).toEqual(['hr_admin']);
 expect(await listApprovalTemplatesForMaintenance(companyHr)).toEqual(await listApprovalTemplates(companyHr));
 expect((await listApprovalTemplates(companyHr)).map(row=>row.id)).toEqual([template.id]);
 const audit=await owner.client`select distinct actor_id from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_type='leave-approval-template'`;expect(audit).toEqual([{actor_id:companyHr.userId}]);
});
it('preserves real member template references while refusing every maintenance mutation and raw delete',async()=>{
 const template=await createApprovalTemplate(admin,{name:'Fictional referenced template',levels:['direct_manager']});
 expect((await listApprovalTemplates(member)).map(row=>row.id)).toEqual([template.id]);
 expect(await Promise.all((['view','add','edit','delete'] as const).map(operation=>approvalTemplateActionAccess(member,operation)))).toEqual([true,false,false,false]);
 const before=await owner.db.select().from(s.leaveApprovalTemplate).where(eq(s.leaveApprovalTemplate.id,template.id));
 await expect(createApprovalTemplate(member,{name:'Fictional refused constructor',levels:['hr_admin']})).rejects.toThrow('Leave approval template action unavailable');
 await expect(deleteApprovalTemplate(member,template.id)).rejects.toThrow('Leave approval template action unavailable');
 await rawRefusal(withTenant(member,tx=>tx.delete(s.leaveApprovalTemplate).where(eq(s.leaveApprovalTemplate.id,template.id))));
 await rawRefusal(withTenant(member,tx=>tx.update(s.leaveApprovalTemplate).set({isTenantDefault:true}).where(eq(s.leaveApprovalTemplate.id,template.id))));
 expect(await owner.db.select().from(s.leaveApprovalTemplate).where(eq(s.leaveApprovalTemplate.id,template.id))).toEqual(before);
});
it('rechecks stored native role/login floors and rejects cross-tenant identity changes',async()=>{
 const template=await createApprovalTemplate(companyHr,{name:'Fictional current template',levels:['hr_admin']});
 await owner.db.update(s.roleAssignment).set({role:'employee'}).where(eq(s.roleAssignment.appUserId,companyHr.userId!));
 expect(await approvalTemplateActionAccess(companyHr,'edit')).toBe(false);await expect(updateApprovalTemplate(companyHr,template.id,{name:'Fictional stale authority',levels:['direct_manager']})).rejects.toThrow('Leave approval template action unavailable');
 await rawRefusal(withTenant(admin,tx=>tx.update(s.leaveApprovalTemplate).set({tenantId:randomUUID()}).where(eq(s.leaveApprovalTemplate.id,template.id))));
 await expect(withTenant(admin,tx=>tx.execute(sql`select app.leave_approval_template_native_allowed(${b.tenantId}::uuid,${b.adminUserId}::uuid,'function.leaveApproval.templates.add',null)`))).rejects.toThrow();
 expect((await owner.db.select().from(s.leaveApprovalTemplate).where(eq(s.leaveApprovalTemplate.id,template.id)))[0].name).toBe('Fictional current template');
});

it('binds assignment create, replacement/reactivation and unassignment to the actual company-native course',async()=>{
 const template=await createApprovalTemplate(companyHr,{name:'Fictional scoped assignment template',levels:['hr_admin']});
 const first=await assignApprovalTemplate(companyHr,{templateId:template.id,companyIds:[b.companyId],leaveTypeIds:[b.annualLeaveTypeId]});expect(first.ruleIds).toHaveLength(1);
 await unassignApprovalTemplate(companyHr,first.ruleIds[0],b.companyId);
 const second=await assignApprovalTemplate(companyHr,{templateId:template.id,companyIds:[b.companyId],leaveTypeIds:[b.annualLeaveTypeId]});expect(second.ruleIds).toEqual(first.ruleIds);
 expect(await withTenant(member,tx=>resolveApprovalChain(tx,b.companyId,b.annualLeaveTypeId))).toEqual(['hr_admin']);
 expect(await leaveApprovalCompanyAccess(companyHr,'leaveApproval.assignments',b.companyId,['view','add','edit','delete'])).toEqual([true,true,true,true]);
 expect(await leaveApprovalCompanyAccess(member,'leaveApproval.assignments',b.companyId,['view','add','edit','delete'])).toEqual([true,false,false,false]);
 await expect(unassignApprovalTemplate(member,first.ruleIds[0],b.companyId)).rejects.toThrow('Leave approval company action unavailable');
});
it('refuses assignment moves outside the actual company grant and foreign template references',async()=>{
 const [otherCompany]=await owner.db.insert(s.company).values({tenantId:b.tenantId,legalName:'Fictional separate approval company'}).returning({id:s.company.id});
 const template=await createApprovalTemplate(admin,{name:'Fictional actual assignment',levels:['direct_manager']});
 const assigned=await assignApprovalTemplate(admin,{templateId:template.id,companyIds:[b.companyId],leaveTypeIds:[b.annualLeaveTypeId]});
 expect(await leaveApprovalCompanyAccess(companyHr,'leaveApproval.assignments',otherCompany.id,['edit'])).toEqual([false]);
 const before=await owner.db.select().from(s.leaveApprovalPolicy).where(eq(s.leaveApprovalPolicy.id,assigned.ruleIds[0]));
 const refuses=async(run:Promise<unknown>)=>{let failure:unknown;try{await run;}catch(error){failure=error;}let denied=false;for(let cause=failure;cause&&typeof cause==='object';cause=(cause as {cause?:unknown}).cause)if((cause as {code?:string}).code==='42501'&&(cause as {message?:string}).message==='Leave approval assignment action unavailable')denied=true;expect(denied).toBe(true);};
 await refuses(withTenant(companyHr,tx=>tx.update(s.leaveApprovalPolicy).set({companyId:otherCompany.id}).where(eq(s.leaveApprovalPolicy.id,assigned.ruleIds[0]))));
 const other=await seedBase(),foreign=await createApprovalTemplate(adminCtx(other),{name:'Fictional foreign tenant template',levels:['hr_admin']});
 await refuses(withTenant(companyHr,tx=>tx.update(s.leaveApprovalPolicy).set({templateId:foreign.id}).where(eq(s.leaveApprovalPolicy.id,assigned.ruleIds[0]))));
 await refuses(withTenant(member,tx=>tx.delete(s.leaveApprovalPolicy).where(eq(s.leaveApprovalPolicy.id,assigned.ruleIds[0]))));
 expect(await owner.db.select().from(s.leaveApprovalPolicy).where(eq(s.leaveApprovalPolicy.id,assigned.ruleIds[0]))).toEqual(before);
});
it('binds the real escalation setter to native company Edit while preserving member references',async()=>{
 expect(await leaveApprovalCompanyAccess(companyHr,'leaveApproval.escalation',b.companyId,['view','edit'])).toEqual([true,true]);
 expect(await leaveApprovalCompanyAccess(member,'leaveApproval.escalation',b.companyId,['view','edit'])).toEqual([true,false]);
 await setLeaveEscalationPolicy(companyHr,{companyId:b.companyId,enabled:true,escalateAfterDays:4,target:'next_level'});
 expect(await getLeaveEscalationPolicy(member,b.companyId)).toEqual({enabled:true,escalateAfterDays:4,target:'next_level',targetRole:null});
 expect(await getLeaveEscalationPolicyForMaintenance(member,b.companyId)).toEqual(await getLeaveEscalationPolicy(member,b.companyId));
 await expect(setLeaveEscalationPolicy(member,{companyId:b.companyId,enabled:false})).rejects.toThrow('Leave approval company action unavailable');
 const [company]=await owner.db.select().from(s.company).where(eq(s.company.id,b.companyId));
 const image=JSON.stringify(company); // Runtime callers cannot invoke or post images to this private guard API.
 await expect(withTenant(companyHr,tx=>tx.execute(sql`select app.leave_approval_escalation_source_allowed(${image}::jsonb,${image}::jsonb)`))).rejects.toThrow();
 const audit=await owner.client`select actor_id,payload from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${b.companyId}::uuid and event_type='leave-escalation-policy.updated'`;expect(audit).toHaveLength(1);expect(audit[0].actor_id).toBe(companyHr.userId);
});

it('shares the actual assignment bucket for read-only preview, new Add and archived-row Edit',async()=>{
 const template=await createApprovalTemplate(companyHr,{name:'Fictional preview template',levels:['hr_admin']}),input={templateId:template.id,companyIds:[b.companyId],leaveTypeIds:[b.annualLeaveTypeId]};
 const before=await owner.db.select().from(s.leaveApprovalPolicy),audit=await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`,configuration=await owner.client`select * from access_configuration where tenant_id=${b.tenantId}::uuid`;
 expect(await previewApprovalTemplateAssignment(companyHr,input)).toEqual({allowed:true,count:1});expect(await previewApprovalTemplateAssignment(companyHr,input)).toEqual({allowed:true,count:1});
 expect(await owner.db.select().from(s.leaveApprovalPolicy)).toEqual(before);expect(await owner.client`select id from domain_event where tenant_id=${b.tenantId}::uuid order by id`).toEqual(audit);expect(await owner.client`select * from access_configuration where tenant_id=${b.tenantId}::uuid`).toEqual(configuration);
 const slot=()=>withTenant(companyHr,tx=>tx.execute<{id:string|null;operation:string;allowed:boolean}>(sql`select id,operation,allowed from app.leave_approval_assignment_slot(${b.companyId}::uuid,${b.annualLeaveTypeId}::uuid,null,null,null,null)`));
 expect(await slot()).toEqual([{id:null,operation:'add',allowed:true}]);
 const first=await assignApprovalTemplate(companyHr,input);expect(await slot()).toEqual([{id:first.ruleIds[0],operation:'edit',allowed:true}]);
 await unassignApprovalTemplate(companyHr,first.ruleIds[0],b.companyId);expect(await slot()).toEqual([{id:first.ruleIds[0],operation:'edit',allowed:true}]);
 expect(await previewApprovalTemplateAssignment(companyHr,input)).toEqual({allowed:true,count:1});expect((await assignApprovalTemplate(companyHr,input)).ruleIds).toEqual(first.ruleIds);
});
it('cannot turn a posted preview selection into source authority or a private lookup grant',async()=>{
 const template=await createApprovalTemplate(admin,{name:'Fictional denied preview',levels:['hr_admin']}),input={templateId:template.id,companyIds:[b.companyId],leaveTypeIds:[b.annualLeaveTypeId]};
 expect(await previewApprovalTemplateAssignment(member,input)).toEqual({allowed:false,count:1});expect(await previewApprovalTemplateAssignment(companyHr,{...input,leaveTypeIds:[randomUUID()]})).toEqual({allowed:false,count:1});
 await expect(withTenant(companyHr,tx=>tx.execute(sql`select * from app.leave_approval_assignment_bucket(${b.tenantId}::uuid,${b.companyId}::uuid,${b.annualLeaveTypeId}::uuid,null,null,null,null)`))).rejects.toThrow();
 expect(await owner.db.select().from(s.leaveApprovalPolicy)).toEqual([]);
});

it('publishes templates and preserves company HR creation under a scoped Edit denial',async()=>{
 const cap='function.leaveApproval.templates.edit';
 try{
  expect(await publishActionCapabilityPackage(owner.client,'leave_approval_templates')).toMatchObject({changed:true,capabilities:4});
  expect(await publishActionCapabilityPackage(owner.client,'leave_approval_templates')).toMatchObject({changed:false});
  const template=await createApprovalTemplate(companyHr,{name:'Fictional publication template',levels:['direct_manager']});
  await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect)
   values(${b.tenantId}::uuid,${companyHr.userId!}::uuid,${cap},null,'deny')`;
  await expect(updateApprovalTemplate(companyHr,template.id,{name:'Fictional denied update',levels:['hr_admin']})).rejects.toThrow('Leave approval template action unavailable');
  await expect(createApprovalTemplate(companyHr,{name:'Fictional separate constructor',levels:['direct_manager']})).resolves.toMatchObject({id:expect.any(String)});
  expect((await listApprovalTemplatesForMaintenance(companyHr)).map(row=>row.id)).toContain(template.id);
 }finally{
  await owner.client`delete from access_user_override where tenant_id=${b.tenantId}::uuid and capability_id=${cap}`;
  await owner.client`update access_capability set supported=false,bindings='[]'::jsonb where id like 'function.leaveApproval.templates.%'`;
 }
});

it('publishes company approval courses and blocks raw escalation changes under exact Edit denial',async()=>{
 const cap='function.leaveApproval.escalation.edit';
 try{
  expect(await publishActionCapabilityPackage(owner.client,'leave_approval_company')).toMatchObject({changed:true,capabilities:6});
  expect(await publishActionCapabilityPackage(owner.client,'leave_approval_company')).toMatchObject({changed:false});
  await setLeaveEscalationPolicy(admin,{companyId:b.companyId,enabled:true,escalateAfterDays:4});
  await owner.client`insert into access_user_override(tenant_id,user_id,capability_id,company_id,effect)
   values(${b.tenantId}::uuid,${admin.userId!}::uuid,${cap},${b.companyId}::uuid,'deny')`;
  await expect(setLeaveEscalationPolicy(admin,{companyId:b.companyId,enabled:false})).rejects.toThrow('Leave approval company action unavailable');
  await expect(withTenant(admin,tx=>tx.update(s.company).set({escalationEnabled:false}).where(eq(s.company.id,b.companyId))))
   .rejects.toThrow();
  expect(await leaveApprovalCompanyAccess(admin,'leaveApproval.assignments',b.companyId,['view','add','edit','delete'])).toEqual([true,true,true,true]);
  expect(await getLeaveEscalationPolicyForMaintenance(admin,b.companyId)).toMatchObject({enabled:true,escalateAfterDays:4});
 }finally{
  await owner.client`delete from access_user_override where tenant_id=${b.tenantId}::uuid and capability_id=${cap}`;
  await owner.client`update access_capability set supported=false,bindings='[]'::jsonb
   where id like 'function.leaveApproval.assignments.%' or id like 'function.leaveApproval.escalation.%'`;
 }
});
