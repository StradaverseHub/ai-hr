/** Exact template-native courses. No fabricated publication/default bindings. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {createApprovalTemplate,updateApprovalTemplate,duplicateApprovalTemplate,setApprovalTemplateActive,setTenantDefaultTemplate,deleteApprovalTemplate,listApprovalTemplates,approvalTemplateActionAccess} from '../core/leave-approval-template';
import {resolveApprovalChain} from '../core/leave-approval-policy';
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
