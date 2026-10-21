/** Real restricted-runtime storage contracts. This does not claim unfinished Workforce consumers work. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {withTenant,type SessionContext} from '../db/client';
import {appUser,roleAssignment,company,employment,accessGroup,accessConfiguration,domainEvent} from '../db/schema';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {revokeRole} from '../core/admin';
import {hireEmployee} from '../core/org';
import {todayInKualaLumpur} from '../lib/hr-date';
import {pgSqlState} from '../lib/db-error';
import type {AccessConfigurationCommand} from '../lib/access-configuration-command';
let b:Base;
beforeAll(migrateTestDb);
beforeEach(async()=>{
 await resetDb();b=await seedBase();
 // Catalogue data survives tenant TRUNCATE. Restore the migration's unimplemented consumer boundary.
 await owner.db.execute(sql`update access_capability set supported=false,bindings='[]'::jsonb where id in ('workforce.view','workforce.maintain','profile.review')`);
});
afterAll(closeAll);
const admin=()=>({...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]});
const state=(ctx:SessionContext=admin())=>withTenant(ctx,tx=>accessConfigurationStore.loadCurrent(tx,ctx));
async function change(command:AccessConfigurationCommand,ctx:SessionContext=admin()){
 const current=await state(ctx),edit={expectedRevision:current.snapshot.revision,command};
 const preview=await previewAccessConfiguration(ctx,edit,accessConfigurationStore);
 return saveAccessConfiguration(ctx,{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore);
}
async function login(role:'hr_admin'|'employee'){
 const [user]=await owner.db.insert(appUser).values({tenantId:b.tenantId,workosUserId:`fictional_${randomUUID()}`}).returning({id:appUser.id});
 const [grant]=await owner.db.insert(roleAssignment).values({tenantId:b.tenantId,appUserId:user.id,role,companyId:null}).returning({id:roleAssignment.id});
 return {userId:user.id,grantId:grant.id,ctx:{...adminCtx(b),userId:user.id,roles:[role],grants:[{role,companyId:null}]} satisfies SessionContext};
}
async function fixtureCapability(){
 // Isolated algebra fixture only, not evidence that a product capability has complete consumers.
 await owner.db.execute(sql`update access_capability set supported=true,bindings='[{"owner":"fictional-sql-algebra-fixture","operation":"read"}]'::jsonb where id='workforce.view'`);
}
const canView=(ctx:SessionContext,companyId:string)=>withTenant(ctx,async tx=>{
 const [row]=await tx.execute<{allowed:boolean}>(sql`select app.access_capability_allowed('workforce.view',${companyId}::uuid) as allowed`);return row.allowed;
});
async function sqlRefusal(run:()=>Promise<unknown>,code:string){
 let refusal:unknown;try{await run();}catch(error){refusal=error;}
 expect(refusal).toBeDefined();expect(pgSqlState(refusal)).toBe(code);
}

describe('canonical access storage under ai_hr_app',()=>{
 it('creates defaults without rewriting roles and derives default membership from the live role owner',async()=>{
  const before=await owner.db.select().from(roleAssignment).where(eq(roleAssignment.tenantId,b.tenantId)).orderBy(roleAssignment.id);
  // The first real administrator installs defaults at transaction end, before any page is opened.
  const [automatic]=await owner.db.select().from(accessConfiguration).where(eq(accessConfiguration.tenantId,b.tenantId));expect(automatic?.initialized).toBe(true);
  const current=await state();
  expect(current.snapshot.groups).toHaveLength(6);
  expect(current.snapshot.memberships.filter(row=>row.userId===b.adminUserId)).toEqual(expect.arrayContaining([expect.objectContaining({derived:true,companyId:null})]));
  expect(await owner.db.select().from(roleAssignment).where(eq(roleAssignment.tenantId,b.tenantId)).orderBy(roleAssignment.id)).toEqual(before);
  const [initialized]=await owner.db.select({payload:domainEvent.payload}).from(domainEvent).where(and(eq(domainEvent.tenantId,b.tenantId),eq(domainEvent.eventType,'access-configuration.initialized')));
  expect(initialized.payload).toEqual({defaultsCreated:true,legacyRolesChanged:false});
 });
 it('refuses forged/stale administrator roles and direct runtime table or private-function writes',async()=>{
  await state();const employee=await login('employee');
  await expect(state({...employee.ctx,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]})).rejects.toMatchObject({code:'ceiling'});
  await sqlRefusal(()=>withTenant(admin(),tx=>tx.execute(sql`delete from access_group where tenant_id=${b.tenantId}`)),'42501');
  await sqlRefusal(()=>withTenant(admin(),tx=>tx.execute(sql`select app.access_can_delegate('access.configure',NULL)`)),'42501');
  await sqlRefusal(()=>withTenant(admin(),tx=>tx.execute(sql`select app.access_install_defaults(${b.tenantId}::uuid,${b.adminUserId}::uuid)`)),'42501');
  await sqlRefusal(()=>withTenant(admin(),tx=>tx.execute(sql`select app.access_allowed_for_tenant(${b.tenantId}::uuid,${b.adminUserId}::uuid,'access.configure',NULL)`)),'42501');
  await sqlRefusal(()=>withTenant(employee.ctx,tx=>tx.execute(sql`select * from access_user_override`)),'42501');
 });
 it('saves/reopens a group and records exactly one bounded change event',async()=>{
  const groupId=randomUUID();await change({kind:'createGroup',groupId,name:'Fictional private group label'});
  expect((await state()).snapshot.groups).toContainEqual(expect.objectContaining({id:groupId,name:'Fictional private group label',systemAdministrator:false}));
  const events=await owner.db.select({payload:domainEvent.payload}).from(domainEvent).where(and(eq(domainEvent.tenantId,b.tenantId),eq(domainEvent.eventType,'access-configuration.changed'))).orderBy(domainEvent.id);
  expect(events).toHaveLength(1);expect(events[0].payload).toMatchObject({kind:'createGroup',groupId,created:true});
  expect(JSON.stringify(events)).not.toContain('Fictional private group label');
 });
 it('keeps unsupported controls unavailable and independently rejects a foreign company in raw SQL',async()=>{
  const groupId=randomUUID();await change({kind:'createGroup',groupId,name:'Fictional scope fixture'});
  await expect(change({kind:'replaceGroupGrants',groupId,grants:[{capabilityId:'workforce.view',companyId:null}]})).rejects.toMatchObject({code:'unsupported'});
  const other=await seedBase(),user=await login('employee'),current=await state();
  await sqlRefusal(()=>withTenant(admin(),tx=>tx.execute(sql`select app.access_configuration_commit(${current.snapshot.revision}::uuid,${current.scopeFingerprint},${JSON.stringify({kind:'setMembership',groupId,userId:user.userId,companyId:other.companyId,enabled:true})}::jsonb,${randomUUID()}::uuid)`)),'23514');
  expect((await state()).snapshot.memberships.some(row=>row.companyId===other.companyId)).toBe(false);
 });
 it('intersects membership and group scope and makes an individual denial win in the actual SQL resolver',async()=>{
  await fixtureCapability();const user=await login('employee');
  const [otherCompany]=await owner.db.insert(company).values({tenantId:b.tenantId,legalName:'Fictional unrelated company'}).returning({id:company.id});
  const groupId=randomUUID();await change({kind:'createGroup',groupId,name:'Fictional readers'});
  await change({kind:'replaceGroupGrants',groupId,grants:[{capabilityId:'workforce.view',companyId:null}]});
  await change({kind:'setMembership',groupId,userId:user.userId,companyId:b.companyId,enabled:true});
  expect(await canView(user.ctx,b.companyId)).toBe(true);expect(await canView(user.ctx,otherCompany.id)).toBe(false);
  await change({kind:'setOverride',userId:user.userId,capabilityId:'workforce.view',companyId:b.companyId,effect:'deny'});
  expect(await canView(user.ctx,b.companyId)).toBe(false);
  const reopened=await state();expect(reopened.snapshot.overrides).toContainEqual({userId:user.userId,capabilityId:'workforce.view',companyId:b.companyId,effect:'deny'});
 });
 it('refuses a stale preview and a revoked real principal despite an unchanged SessionContext',async()=>{
  const second=await login('hr_admin'),current=await state(),command={kind:'createGroup' as const,groupId:randomUUID(),name:'Never committed'};
  const edit={expectedRevision:current.snapshot.revision,command};const preview=await previewAccessConfiguration(second.ctx,edit,accessConfigurationStore);
  await change({kind:'createGroup',groupId:randomUUID(),name:'Different committed change'});
  await expect(saveAccessConfiguration(second.ctx,{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore)).rejects.toMatchObject({code:'changed'});
  await revokeRole(admin(),{roleAssignmentId:second.grantId});
  await expect(state(second.ctx)).rejects.toMatchObject({code:'ceiling'});
 });
 it('does not commit two concurrent removals of the final real administrators through legacy role writers',async()=>{
  const second=await login('hr_admin');await state();
  const [firstGrant]=await owner.db.select({id:roleAssignment.id}).from(roleAssignment).where(and(eq(roleAssignment.tenantId,b.tenantId),eq(roleAssignment.appUserId,b.adminUserId),eq(roleAssignment.role,'hr_admin')));
  const results=await Promise.allSettled([revokeRole(admin(),{roleAssignmentId:firstGrant.id}),revokeRole(second.ctx,{roleAssignmentId:second.grantId})]);
  expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);
  const failure=results.find(result=>result.status==='rejected');expect(failure?.status==='rejected'?pgSqlState(failure.reason):null).toBe('23514');
  const remaining=await owner.db.select({id:roleAssignment.id}).from(roleAssignment).where(and(eq(roleAssignment.tenantId,b.tenantId),eq(roleAssignment.role,'hr_admin'))).orderBy(roleAssignment.id);
  expect(remaining).toHaveLength(1);
 });
 it('refuses leaving only a currently active administrator whose known employment end will remove login access',async()=>{
  const today=todayInKualaLumpur(),end=new Date(`${today}T00:00:00Z`);end.setUTCDate(end.getUTCDate()+2);
  const endOn=end.toISOString().slice(0,10),afterEnd=new Date(end);afterEnd.setUTCDate(afterEnd.getUTCDate()+1);
  const hired=await hireEmployee(admin(),{person:{fullName:'Fictional ending administrator'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:today});
  const endingUser=await createAppUser(b.tenantId,hired.personId,'hr_admin');
  await owner.db.update(employment).set({terminatedOn:endOn}).where(eq(employment.id,hired.employmentId));
  const current=await state();expect(current.snapshot.users.find(user=>user.id===endingUser)?.active).toBe(true);
  expect(current.recoveryUserIds.has(endingUser)).toBe(false);expect(current.recoveryUserIds.has(b.adminUserId)).toBe(true);
  const [dates]=await owner.db.execute<{todayBlocked:boolean;endBlocked:boolean;afterBlocked:boolean}>(sql`select app.login_blocked(${endingUser}::uuid) as "todayBlocked",app.login_blocked_on(${endingUser}::uuid,${endOn}::date) as "endBlocked",app.login_blocked_on(${endingUser}::uuid,${afterEnd.toISOString().slice(0,10)}::date) as "afterBlocked"`);
  expect(dates).toEqual({todayBlocked:false,endBlocked:false,afterBlocked:true});
  await sqlRefusal(()=>withTenant(admin(),tx=>tx.execute(sql`select app.login_blocked_on(${endingUser}::uuid,current_date)`)),'42501');
  const [firstGrant]=await owner.db.select({id:roleAssignment.id}).from(roleAssignment).where(and(eq(roleAssignment.tenantId,b.tenantId),eq(roleAssignment.appUserId,b.adminUserId),eq(roleAssignment.role,'hr_admin')));
  await sqlRefusal(()=>revokeRole(admin(),{roleAssignmentId:firstGrant.id}),'23514');
  const retained=await owner.db.select({id:roleAssignment.id}).from(roleAssignment).where(eq(roleAssignment.id,firstGrant.id));expect(retained).toHaveLength(1);
 });
 it('rolls the complete permission edit back when the actual audit insert fails',async()=>{
  const current=await state(),groupId=randomUUID(),command={kind:'createGroup' as const,groupId,name:'Audit refusal fixture'};
  const edit={expectedRevision:current.snapshot.revision,command},preview=await previewAccessConfiguration(admin(),edit,accessConfigurationStore);
  await owner.db.execute(sql.raw("CREATE FUNCTION app.test_access_audit_refusal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type='access-configuration.changed' THEN RAISE EXCEPTION 'fictional audit refusal' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$"));
  await owner.db.execute(sql.raw('CREATE TRIGGER test_access_audit_refusal BEFORE INSERT ON domain_event FOR EACH ROW EXECUTE FUNCTION app.test_access_audit_refusal()'));
  try{await sqlRefusal(()=>saveAccessConfiguration(admin(),{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore),'P0001');}
  finally{await owner.db.execute(sql.raw('DROP TRIGGER test_access_audit_refusal ON domain_event'));await owner.db.execute(sql.raw('DROP FUNCTION app.test_access_audit_refusal()'));}
  expect(await owner.db.select().from(accessGroup).where(eq(accessGroup.id,groupId))).toEqual([]);
  const [revision]=await owner.db.select({value:accessConfiguration.revision}).from(accessConfiguration).where(eq(accessConfiguration.tenantId,b.tenantId));expect(revision.value).toBe(current.snapshot.revision);
 });
});
