/** Exact template-native courses. No fabricated publication/default bindings. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {assignApprovalTemplate,unassignApprovalTemplate,createApprovalTemplate,updateApprovalTemplate,duplicateApprovalTemplate,setApprovalTemplateActive,setTenantDefaultTemplate,deleteApprovalTemplate,listApprovalTemplates,approvalTemplateActionAccess} from '../core/leave-approval-template';
import {getLeaveEscalationPolicy,setLeaveEscalationPolicy,resolveApprovalChain} from '../core/leave-approval-policy';
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
 await expect(setLeaveEscalationPolicy(member,{companyId:b.companyId,enabled:false})).rejects.toThrow('Leave approval company action unavailable');
 const [company]=await owner.db.select().from(s.company).where(eq(s.company.id,b.companyId));
 const image=JSON.stringify(company); // Runtime callers cannot invoke or post images to this private guard API.
 await expect(withTenant(companyHr,tx=>tx.execute(sql`select app.leave_approval_escalation_source_allowed(${image}::jsonb,${image}::jsonb)`))).rejects.toThrow();
 const audit=await owner.client`select actor_id,payload from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_id=${b.companyId}::uuid and event_type='leave-escalation-policy.updated'`;expect(audit).toHaveLength(1);expect(audit[0].actor_id).toBe(companyHr.userId);
});
