/** Real restricted-runtime storage contracts. This does not claim unfinished Workforce consumers work. */
import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {and,eq,sql} from 'drizzle-orm';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {withTenant,type SessionContext} from '../db/client';
import {appUser,appInvitation,roleAssignment,company,employment,person,profileChangeRequest,accessGroup,accessConfiguration,domainEvent} from '../db/schema';
import {accessConfigurationStore} from '../core/access-configuration-store';
import {previewAccessConfiguration,saveAccessConfiguration} from '../core/access-configuration';
import {assignRole,revokeRole} from '../core/admin';
import {hireEmployee} from '../core/org';
import {readAccessConfigurationEditor} from '../core/access-configuration-editor';
import {decideProfileChange,listProfileChangeRequests,myProfileChangeRequests} from '../core/profile';
import {requestCurrentProfileChange} from './helpers/profile-requests';
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
  const editor=await readAccessConfigurationEditor(admin());expect(editor.history.filter(event=>event.operation==='createGroup')).toHaveLength(1);
  expect(editor).not.toHaveProperty('recoveryUserIds');expect(editor).not.toHaveProperty('evidence');
  expect(editor.users.every(user=>Object.keys(user).sort().join(',')==='id,label')).toBe(true);
  const employee=await login('employee');await expect(readAccessConfigurationEditor(employee.ctx)).rejects.toMatchObject({code:'ceiling'});
  await sqlRefusal(()=>withTenant(employee.ctx,tx=>tx.execute(sql`select app.access_configuration_editor_metadata()`)),'42501');
  await sqlRefusal(()=>withTenant(admin(),tx=>tx.execute(sql`insert into domain_event(tenant_id,aggregate_type,aggregate_id,event_type,actor_type,actor_id,payload) values(${b.tenantId}::uuid,'access-configuration',${b.tenantId}::uuid,'access-configuration.changed','user',${b.adminUserId}::uuid,'{"kind":"retireGroup"}'::jsonb)`)),'42501');
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
  await sqlRefusal(()=>assignRole(second.ctx,{appUserId:second.userId,role:'hr_admin'}),'42501');
  expect(await owner.db.select({id:roleAssignment.id}).from(roleAssignment).where(eq(roleAssignment.appUserId,second.userId))).toEqual([]);
 });
 it('refuses a pending invitation after the real inviter was revoked and preserves the pending state on refusal',async()=>{
  const second=await login('hr_admin'),token=`fictional_${randomUUID()}`,hash=createHash('sha256').update(token).digest('hex');
  const [invitation]=await withTenant(second.ctx,tx=>tx.insert(appInvitation).values({tenantId:b.tenantId,email:'fictional-access-acceptance@example.invalid',role:'employee',tokenHash:hash,expiresAt:sql`now()+interval '1 hour'`,createdBy:second.userId}).returning({id:appInvitation.id}));
  await revokeRole(admin(),{roleAssignmentId:second.grantId});
  // The same public pre-auth definer used by the app, with no authenticated principal fallback.
  await sqlRefusal(()=>withTenant({tenantId:b.tenantId,roles:[]},tx=>tx.execute(sql`select * from app.consume_invitation(${token},${`fictional_subject_${randomUUID()}`})`)),'42501');
  const [retained]=await owner.db.select({status:appInvitation.status}).from(appInvitation).where(eq(appInvitation.id,invitation.id));expect(retained.status).toBe('pending');
 });
 it('still accepts a current administrator’s valid invitation through the same public definer',async()=>{
  const token=`fictional_${randomUUID()}`,hash=createHash('sha256').update(token).digest('hex'),subject=`fictional_subject_${randomUUID()}`;
  const [invitation]=await withTenant(admin(),tx=>tx.insert(appInvitation).values({tenantId:b.tenantId,email:'fictional-access-success@example.invalid',role:'employee',tokenHash:hash,expiresAt:sql`now()+interval '1 hour'`,createdBy:b.adminUserId}).returning({id:appInvitation.id}));
  const rows=await withTenant({tenantId:b.tenantId,roles:[]},tx=>tx.execute<{app_user_id:string;tenant_id:string}>(sql`select * from app.consume_invitation(${token},${subject})`));
  expect(rows).toHaveLength(1);expect(rows[0].tenant_id).toBe(b.tenantId);
  const [accepted]=await owner.db.select({status:appInvitation.status}).from(appInvitation).where(eq(appInvitation.id,invitation.id));expect(accepted.status).toBe('accepted');
  const grants=await owner.db.select({role:roleAssignment.role}).from(roleAssignment).where(eq(roleAssignment.appUserId,rows[0].app_user_id));expect(grants).toEqual([{role:'employee'}]);
 });
 it('refuses a forged inviter and an explicit configuration denial on the old role surface',async()=>{
  const second=await login('hr_admin'),worker=await login('employee');
  await sqlRefusal(()=>withTenant(second.ctx,tx=>tx.insert(appInvitation).values({tenantId:b.tenantId,email:'fictional-access-forgery@example.invalid',role:'employee',tokenHash:`fictional_${randomUUID()}`,expiresAt:sql`now()+interval '1 hour'`,createdBy:b.adminUserId})),'42501');
  await change({kind:'setOverride',userId:second.userId,capabilityId:'access.configure',companyId:null,effect:'deny'});
  await sqlRefusal(()=>assignRole(second.ctx,{appUserId:worker.userId,role:'manager'}),'42501');
  expect(await owner.db.select({role:roleAssignment.role}).from(roleAssignment).where(eq(roleAssignment.appUserId,worker.userId))).toEqual([{role:'employee'}]);
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
  const hired=await hireEmployee(admin(),{person:{fullName:'Fictional ending administrator',primaryEmail:'fictional-ending-admin@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:today});
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
 it('binds a profile-review denial to queue reads, raw records and the actual decision without blocking the subject’s own history',async()=>{
  // Product activation remains unavailable until the complete consumer matrix passes. This isolated
  // fixture activates only the actual profile adapter being exercised, not the unfinished Workforce.
  await owner.db.execute(sql`update access_capability set supported=true,bindings='[{"owner":"app.access_profile_review_permitted","operation":"review"}]'::jsonb where id='profile.review'`);
  const reviewer=await login('hr_admin');
  const hired=await hireEmployee(admin(),{person:{fullName:'Fictional review subject',primaryEmail:'fictional-profile-review@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
  const employeeUser=await createAppUser(b.tenantId,hired.personId,'employee'),employeeCtx={...admin(),userId:employeeUser,personId:hired.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  const request=await requestCurrentProfileChange(employeeCtx,{employmentId:hired.employmentId,proposed:{preferredName:'Fictional reviewed nickname'}});
  expect((await listProfileChangeRequests(reviewer.ctx,{requestId:request.requestId})).map(row=>row.id)).toEqual([request.requestId]);
  await change({kind:'setOverride',userId:reviewer.userId,capabilityId:'profile.review',companyId:b.companyId,effect:'deny'});
  expect(await listProfileChangeRequests(reviewer.ctx,{requestId:request.requestId})).toEqual([]);
  const raw=await withTenant(reviewer.ctx,async tx=>{
   await tx.execute(sql`select set_config('app.profile_route_maintenance','on',true)`);
   return tx.select({id:profileChangeRequest.id}).from(profileChangeRequest).where(eq(profileChangeRequest.id,request.requestId));
  });expect(raw).toEqual([]);
  const rawWrite=await withTenant(reviewer.ctx,tx=>tx.update(profileChangeRequest).set({status:'approved'}).where(eq(profileChangeRequest.id,request.requestId)).returning({id:profileChangeRequest.id}));expect(rawWrite).toEqual([]);
  await expect(decideProfileChange(reviewer.ctx,{requestId:request.requestId,decision:'approved'})).rejects.toThrow();
  const [unchanged]=await owner.db.select({nickname:person.preferredName}).from(person).where(eq(person.id,hired.personId));expect(unchanged.nickname).toBeNull();
  expect((await myProfileChangeRequests(employeeCtx)).some(row=>row.id===request.requestId)).toBe(true);
  await decideProfileChange(admin(),{requestId:request.requestId,decision:'approved'});
  const [approved]=await owner.db.select({nickname:person.preferredName}).from(person).where(eq(person.id,hired.personId));expect(approved.nickname).toBe('Fictional reviewed nickname');
 });
 it('does not turn a profile-review allow into an HR role or a self-approval grant',async()=>{
  await owner.db.execute(sql`update access_capability set supported=true,bindings='[{"owner":"app.access_profile_review_permitted","operation":"review"}]'::jsonb where id='profile.review'`);
  const hired=await hireEmployee(admin(),{person:{fullName:'Fictional self approval subject',primaryEmail:'fictional-self-approval@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:todayInKualaLumpur()});
  const user=await createAppUser(b.tenantId,hired.personId,'employee'),ctx={...admin(),userId:user,personId:hired.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
  await change({kind:'setOverride',userId:user,capabilityId:'profile.review',companyId:b.companyId,effect:'allow'});
  const request=await requestCurrentProfileChange(ctx,{employmentId:hired.employmentId,proposed:{preferredName:'Must remain pending'}});
  await expect(decideProfileChange(ctx,{requestId:request.requestId,decision:'approved'})).rejects.toThrow();
  const [status]=await owner.db.select({status:profileChangeRequest.status}).from(profileChangeRequest).where(eq(profileChangeRequest.id,request.requestId));expect(status.status).toBe('pending');
 });
});
