/** ADR-0170 step 5a — rule-version labels (migration 0891 and core/outcome-record/rule-versions.ts).
 *
 *  1. Company policy is versioned automatically on every admin edit: leave policy (leave type), approval
 *     rules and approval templates bump `rule_version` on a content change, not on a no-op save, and no
 *     writer can set or rewind it.
 *  2. Each label names exactly what the owner decided: the winning rule (and its template), the tenant
 *     default template, or the built-in chain; the entitlement lineage version in force on the date.
 *  3. Statutory checks name the country pack's published version, through the pack registry. */
import {randomUUID} from 'node:crypto';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import * as schema from '../db/schema';
import {withTenant} from '../db/client';
import {updateLeaveType} from '../core/admin';
import {hireEmployee} from '../core/org';
import {resolveApprovalDecision,resolveEntitlementForEmployment,setLeaveApprovalPolicy} from '../packs/leave/service';
import {BUILTIN_APPROVAL_CHAIN_VERSION,approvalChainVersionTx,entitlementVersionTx,leavePolicyVersionTx,statutoryVersion} from '../core/outcome-record/rule-versions';
import {todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,seedEntitlement,type Base} from './harness';

let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();});
const version=async(table:'leave_type'|'leave_approval_policy'|'leave_approval_template',id:string)=>
 Number((await owner.db.execute(sql`select rule_version from ${sql.identifier(table)} where id=${id}::uuid`))[0].rule_version);

describe('rule-version labels',()=>{
 it('versions the leave policy on every content edit, never on a no-op, and never from a writer',async()=>{
  const admin=adminCtx(b),id=b.annualLeaveTypeId;
  expect(await version('leave_type',id)).toBe(1);
  expect(await withTenant(admin,tx=>leavePolicyVersionTx(tx,id))).toBe(`leave_type:${id}@v1`);
  const [before]=await owner.db.select({name:schema.leaveType.name}).from(schema.leaveType).where(eq(schema.leaveType.id,id));
  await updateLeaveType(admin,{id,name:before.name,requiresDocument:true});
  expect(await version('leave_type',id)).toBe(2);
  await owner.db.update(schema.leaveType).set({requiresDocument:true}).where(eq(schema.leaveType.id,id));
  expect(await version('leave_type',id)).toBe(2);
  // A writer naming a version is overwritten, in either direction.
  await owner.db.execute(sql`update leave_type set rule_version=1 where id=${id}::uuid`);
  expect(await version('leave_type',id)).toBe(2);
  await owner.db.execute(sql`update leave_type set rule_version=99, requires_document=false where id=${id}::uuid`);
  expect(await version('leave_type',id)).toBe(3);
  expect(await withTenant(admin,tx=>leavePolicyVersionTx(tx,id))).toBe(`leave_type:${id}@v3`);
 });

 it('labels the approval chain the owner resolved: built-in, the winning rule, its template, or the tenant default',async()=>{
  const admin=adminCtx(b);
  const decide=()=>withTenant(admin,tx=>resolveApprovalDecision(tx,b.companyId,b.annualLeaveTypeId));
  const label=()=>withTenant(admin,async tx=>approvalChainVersionTx(tx,await resolveApprovalDecision(tx,b.companyId,b.annualLeaveTypeId)));
  expect((await decide()).source).toBe('fallback');expect(await label()).toBe(BUILTIN_APPROVAL_CHAIN_VERSION);
  const [template]=await owner.db.insert(schema.leaveApprovalTemplate).values({tenantId:b.tenantId,name:'Fictional default chain',levels:['hr_admin'],isTenantDefault:true}).returning();
  expect((await decide()).source).toBe('tenant-default');expect(await label()).toBe(`leave_approval_template:${template.id}@v1`);
  await owner.db.update(schema.leaveApprovalTemplate).set({levels:['direct_manager','hr_admin']}).where(eq(schema.leaveApprovalTemplate.id,template.id));
  expect(await label()).toBe(`leave_approval_template:${template.id}@v2`);
  const {id}=await setLeaveApprovalPolicy(admin,{companyId:b.companyId,levels:['direct_manager']});
  const decision=await decide();expect(decision).toMatchObject({source:'rule',ruleId:id});
  expect(await label()).toBe(`leave_approval_policy:${id}@v1`);
  await setLeaveApprovalPolicy(admin,{companyId:b.companyId,levels:['direct_manager']});
  expect(await version('leave_approval_policy',id)).toBe(1);
  await setLeaveApprovalPolicy(admin,{companyId:b.companyId,levels:['direct_manager','hr_admin']});
  expect(await label()).toBe(`leave_approval_policy:${id}@v2`);
  // A rule drawing its levels from a template names both versions.
  await owner.db.update(schema.leaveApprovalPolicy).set({templateId:template.id,levels:[]}).where(eq(schema.leaveApprovalPolicy.id,id));
  expect(await label()).toBe(`leave_approval_policy:${id}@v3+leave_approval_template:${template.id}@v2`);
 });

 it('labels the entitlement table by its existing lineage and the version in force on the date',async()=>{
  const admin=adminCtx(b);
  await seedEntitlement(admin,{leaveTypeId:b.annualLeaveTypeId,annualDays:14,validFrom:'2020-01-01'});
  const hired=await hireEmployee(admin,{person:{fullName:'Fictional Entitlement Employee',primaryEmail:randomUUID()+'@fixture.test'},companyId:b.companyId,
   departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
  const asOf=todayInKualaLumpur();
  const label=await withTenant(admin,async tx=>{
   const resolved=await resolveEntitlementForEmployment(tx,{employmentId:hired.employmentId,leaveTypeId:b.annualLeaveTypeId,asOf});
   expect(resolved).not.toBeNull();return entitlementVersionTx(tx,resolved!,asOf);
  });
  const [table]=await owner.db.select().from(schema.entitlementTemplate).where(eq(schema.entitlementTemplate.leaveTypeId,b.annualLeaveTypeId));
  expect(label.startsWith(`entitlement_template:${table.lineageId}/${table.id}@${table.validFrom}`)).toBe(true);
 });

 it('labels statutory checks with the country pack\'s published version',async()=>{
  const label=await statutoryVersion(adminCtx(b),'MY',todayInKualaLumpur());
  expect(label).toMatch(/^statutory:MY:(pack:[^@]+@\S+|override:[^@]+@\d{4}-\d{2}-\d{2}|builtin@\S+)$/);
  await expect(statutoryVersion(adminCtx(b),'ZZ',todayInKualaLumpur())).rejects.toThrow(/No country pack/);
 });
});
