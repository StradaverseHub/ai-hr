// Lane K (handoff B7; migration 5763): Probation roles with permissions, scoped and dated members, the Direct Superiors
// rule and System Administrators, enforced in the existing Probation owners. Fictional people and companies only.
import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {withTenant,type SessionContext} from '../db/client';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,setModule,type Base} from './harness';
import {createCompany} from '../core/admin';
import {todayInKualaLumpur} from '../lib/hr-date';
import {addDaysIso} from '../lib/roster-month';
import {probationFormCaseFixture} from './helpers/probation-form-case-fixture';
import {probationOutcomeFixture} from './helpers/probation-outcome-fixture';
import {addProbationAccessMember,changeProbationAccessMember,probationAccessView,probationNavigationAccess,probationIntakeCompanies,recordProbationLowResultAction,
 overrideProbationRoute,probationLetterTemplateChoices,retireProbationAccessRole,revokeProbationAccessMember,saveProbationAccessRole,saveProbationSettingsScope,
 saveProbationSuperiorRule,probationCase,actOnProbation,DEFAULT_PROBATION_CONFIG,type ProbationAccessPermission} from '../packs/probation/service';

let b:Base,admin:SessionContext;
const today=todayInKualaLumpur();
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'lifecycle','active');admin=adminCtx(b);});

const caseAccess=(ctx:SessionContext,caseId:string)=>withTenant(ctx,async tx=>(await tx.execute<{ok:boolean}>(sql`select app.probation_case_access(${caseId}::uuid) as ok`))[0].ok);
const role=(ctx:SessionContext,employmentId:string,name:string)=>withTenant(ctx,async tx=>(await tx.execute<{ok:boolean}>(sql`select app.probation_role(${employmentId}::uuid,${name}) as ok`))[0].ok);
const configAdmin=(ctx:SessionContext,companyId:string)=>withTenant(ctx,async tx=>(await tx.execute<{ok:boolean}>(sql`select app.probation_config_admin(${companyId}::uuid) as ok`))[0].ok);
async function grantRole(by:SessionContext,permissions:ProbationAccessPermission[],userId:string,scope:{businessGroupId?:string|null;companyId?:string|null;validFrom?:string;validTo?:string|null}={}){
 const created=await saveProbationAccessRole(by,{roleId:null,name:'Fictional role '+randomUUID().slice(0,8),permissions,expectedRevision:0});
 const memberId=await addProbationAccessMember(by,{roleId:created.id,userId,businessGroupId:scope.businessGroupId??null,companyId:scope.companyId??null,validFrom:scope.validFrom??'2026-01-01',validTo:scope.validTo??null});
 return{roleId:created.id,revision:created.revision,memberId};
}
async function outsider(name:string){
 const[p]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,${name},${randomUUID()+'@access.example.test'}) returning id`);
 const userId=await createAppUser(b.tenantId,p.id,'employee');
 return{userId,personId:p.id,ctx:{...admin,userId,personId:p.id,roles:['employee'],grants:undefined} as SessionContext};
}

describe('who may change Probation access',()=>{
 it('lets a System Administrator or a holder of manage access change roles, members and the rule, audited, and nobody else',async()=>{
  expect(await probationAccessView(admin)).toMatchObject({rule:{enabled:true,view:true,recordDeclined:true,revision:0},roles:[]});
  const plain=await outsider('Fictional plain employee');
  expect(await probationAccessView(plain.ctx)).toBeNull();
  await expect(saveProbationAccessRole(plain.ctx,{roleId:null,name:'Self-made',permissions:['cases.view'],expectedRevision:0})).rejects.toMatchObject({code:'forbidden'});
  await expect(saveProbationSuperiorRule(plain.ctx,{enabled:false,view:true,recordDeclined:true,expectedRevision:0})).rejects.toMatchObject({code:'forbidden'});
  await expect(withTenant(plain.ctx,tx=>tx.execute(sql`select app.probation_access_view()`))).rejects.toThrow();
  expect((await probationNavigationAccess(plain.ctx)).access).toBe(false);expect((await probationNavigationAccess(admin)).access).toBe(true);
  // The existing ADR-0135 "manage access" capability (access.configure) is reused, not a new one.
  const manager=await outsider('Fictional access manager');
  await owner.db.execute(sql`insert into access_user_override(tenant_id,user_id,capability_id,effect) values(${b.tenantId}::uuid,${manager.userId}::uuid,'access.configure','allow')`);
  const made=await saveProbationAccessRole(manager.ctx,{roleId:null,name:'People Business Partner',permissions:['cases.view','cases.letters'],expectedRevision:0});
  await expect(saveProbationAccessRole(admin,{roleId:null,name:' people business partner ',permissions:['cases.view'],expectedRevision:0})).rejects.toMatchObject({code:'conflict'});
  await expect(saveProbationAccessRole(admin,{roleId:made.id,name:'People Business Partner',permissions:[],expectedRevision:1})).rejects.toMatchObject({code:'invalid'});
  await expect(saveProbationAccessRole(admin,{roleId:made.id,name:'People Business Partner',permissions:['cases.view'],expectedRevision:7})).rejects.toMatchObject({code:'conflict'});
  const changed=await saveProbationAccessRole(admin,{roleId:made.id,name:'People Business Partner',permissions:['cases.view','cases.route'],expectedRevision:1});
  expect(changed.revision).toBe(2);
  const member=await addProbationAccessMember(admin,{roleId:made.id,userId:plain.userId,businessGroupId:null,companyId:b.companyId,validFrom:'2026-01-01',validTo:null});
  await expect(addProbationAccessMember(admin,{roleId:made.id,userId:plain.userId,businessGroupId:null,companyId:b.companyId,validFrom:'2026-02-01',validTo:null})).rejects.toMatchObject({code:'conflict'});
  await expect(addProbationAccessMember(admin,{roleId:made.id,userId:plain.userId,businessGroupId:null,companyId:null,validFrom:'2026-03-01',validTo:'2026-02-01'})).rejects.toMatchObject({code:'invalid'});
  const moved=await changeProbationAccessMember(admin,{memberId:member,businessGroupId:null,companyId:null,validFrom:'2026-01-01',validTo:null});
  await revokeProbationAccessMember(admin,{memberId:moved,reason:'Left the team'});
  await saveProbationSuperiorRule(admin,{enabled:true,view:true,recordDeclined:false,expectedRevision:0});
  await expect(saveProbationSuperiorRule(admin,{enabled:true,view:true,recordDeclined:true,expectedRevision:0})).rejects.toMatchObject({code:'conflict'});
  await retireProbationAccessRole(admin,{roleId:made.id,expectedRevision:2,reason:'Replaced'});
  const events=await owner.db.execute<{type:string;actor:string}>(sql`select event_type as type,actor_id::text as actor from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_type='probation_access' order by sequence,id`);
  expect(events.map(e=>e.type)).toEqual(['probation.access.role_created','probation.access.role_changed','probation.access.member_added','probation.access.member_changed','probation.access.member_revoked','probation.access.direct_superiors_saved','probation.access.role_retired']);
  expect(events[0].actor).toBe(manager.userId);
  // History is kept: revoked memberships stay, with who and why.
  const [kept]=await owner.db.execute<{n:number;why:string[]}>(sql`select count(*)::int n,array_agg(revocation_reason order by created_at) why from probation_access_member where tenant_id=${b.tenantId}::uuid`);
  expect(kept).toEqual({n:2,why:['Changed','Left the team']});
  expect((await probationAccessView(admin))!.roles).toEqual([]);
  // No direct table access for the application.
  await expect(withTenant(admin,tx=>tx.execute(sql`select * from probation_access_role`))).rejects.toThrow();
  await expect(withTenant(admin,tx=>tx.execute(sql`insert into probation_access_rule(tenant_id,direct_superiors,superior_view,superior_declined,revision,updated_by) values(${b.tenantId}::uuid,false,false,false,1,${admin.userId}::uuid)`))).rejects.toThrow();
 });
});

describe('Cases: View cases',()=>{
 it('shows the cases in the member\'s company or business group while the membership is current, and nothing else',async()=>{
  const fixture=probationFormCaseFixture(b,admin),{ids,staff}=await fixture.caseWithRows([]);admin=fixture.admin();
  const peer=await fixture.person('Fictional Viewer'); // the fixture's own peer heads the department
  const other=await createCompany(admin,{legalName:'Fictional Other Group Sdn Bhd',country:'MY',currency:'MYR'});
  const child=await createCompany(admin,{legalName:'Fictional Child Sdn Bhd',country:'MY',currency:'MYR',parentCompanyId:b.companyId});
  expect(await caseAccess(peer.ctx,ids.caseId)).toBe(false);
  // Granted by company, then by business group (the group company), and for the whole organisation.
  const company=await grantRole(admin,['cases.view'],peer.userId,{companyId:b.companyId});
  expect(await caseAccess(peer.ctx,ids.caseId)).toBe(true);
  // Viewing gives no action: the low-result, route and letter owners still refuse.
  expect(await withTenant(peer.ctx,async tx=>(await tx.execute<{ok:boolean}>(sql`select app.probation_case_permitted(${staff.employmentId}::uuid,'cases.route') as ok`))[0].ok)).toBe(false);
  await revokeProbationAccessMember(admin,{memberId:company.memberId});
  expect(await caseAccess(peer.ctx,ids.caseId)).toBe(false);
  const group=await grantRole(admin,['cases.view'],peer.userId,{businessGroupId:b.companyId});
  expect(await caseAccess(peer.ctx,ids.caseId)).toBe(true);
  await revokeProbationAccessMember(admin,{memberId:group.memberId});
  // Out of scope: another business group, another company of the same group.
  await grantRole(admin,['cases.view'],peer.userId,{businessGroupId:other.id});
  await grantRole(admin,['cases.view'],peer.userId,{businessGroupId:b.companyId,companyId:child.id});
  expect(await caseAccess(peer.ctx,ids.caseId)).toBe(false);
  // A company outside the chosen business group is refused.
  await expect(grantRole(admin,['cases.view'],peer.userId,{businessGroupId:other.id,companyId:b.companyId})).rejects.toMatchObject({code:'invalid'});
  // Expired and not yet valid memberships give nothing.
  const expired=await grantRole(admin,['cases.view'],peer.userId,{companyId:b.companyId,validFrom:'2026-01-01',validTo:addDaysIso(today,-1)});
  const future=await grantRole(admin,['cases.view'],peer.userId,{companyId:b.companyId,validFrom:addDaysIso(today,1)});
  expect(await caseAccess(peer.ctx,ids.caseId)).toBe(false);
  // Dates are effective: moving the start to today opens it; a retired role closes it again.
  await changeProbationAccessMember(admin,{memberId:future.memberId,businessGroupId:null,companyId:b.companyId,validFrom:today,validTo:null});
  expect(await caseAccess(peer.ctx,ids.caseId)).toBe(true);
  await retireProbationAccessRole(admin,{roleId:future.roleId,expectedRevision:future.revision});
  expect(await caseAccess(peer.ctx,ids.caseId)).toBe(false);
  void expired;
  // The whole organisation (no business group, no company).
  await grantRole(admin,['cases.view'],peer.userId);
  expect(await caseAccess(peer.ctx,ids.caseId)).toBe(true);
 });

 it('keeps today\'s rule for System Administrators: no case without a role, which they can give themselves (audited)',async()=>{
  const fixture=probationOutcomeFixture(b,admin),{ids,staff}=await fixture.recordedConfirm([],{rating:1});admin=fixture.admin();
  const[p]=await owner.db.execute<{id:string}>(sql`insert into person(tenant_id,full_name,primary_email) values(${b.tenantId}::uuid,'Fictional System Administrator',${randomUUID()+'@access.example.test'}) returning id`);
  const sysadmin={...admin,userId:await createAppUser(b.tenantId,p.id,'super_admin'),personId:p.id,roles:['super_admin'],grants:undefined} as SessionContext;
  // "Setup permission is not participant authority" (test/probation-persistence.test.ts) stays true.
  expect(await caseAccess(sysadmin,ids.caseId)).toBe(false);
  await expect(recordProbationLowResultAction(sysadmin,{partId:ids.part,note:'Not the PBP'})).rejects.toThrow();
  expect((await probationNavigationAccess(sysadmin)).access).toBe(true);
  // Adding themselves to a role is the audited way to see and act.
  await grantRole(sysadmin,['cases.low_result'],sysadmin.userId!);
  expect(await caseAccess(sysadmin,ids.caseId)).toBe(true);
  await recordProbationLowResultAction(sysadmin,{partId:ids.part,note:'Agreed a coaching plan with the Line Manager'});
  void staff;
 });
});

describe('Cases: actions',()=>{
 it('Record low-result actions: granted in scope, refused when missing, out of scope or on the member\'s own case',async()=>{
  const fixture=probationOutcomeFixture(b,admin),{ids,staff,peer}=await fixture.recordedConfirm([],{rating:1});admin=fixture.admin();
  const other=await createCompany(admin,{legalName:'Fictional Elsewhere Sdn Bhd',country:'MY',currency:'MYR'});
  await expect(recordProbationLowResultAction(peer.ctx,{partId:ids.part,note:'Fictional note'})).rejects.toThrow();
  await grantRole(admin,['cases.view','cases.letters','cases.route'],peer.userId,{companyId:b.companyId});
  await grantRole(admin,['cases.low_result'],peer.userId,{companyId:other.id});
  await expect(recordProbationLowResultAction(peer.ctx,{partId:ids.part,note:'Fictional note'})).rejects.toThrow();
  // Never on one's own probation, whatever the role says.
  await grantRole(admin,['cases.low_result'],staff.userId);
  await expect(recordProbationLowResultAction(staff.ctx,{partId:ids.part,note:'My own case'})).rejects.toThrow();
  await grantRole(admin,['cases.low_result'],peer.userId,{companyId:b.companyId});
  await recordProbationLowResultAction(peer.ctx,{partId:ids.part,note:'Agreed a coaching plan with the Line Manager'});
  const[row]=await owner.db.execute<{actor:string}>(sql`select actor_user_id::text as actor from probation_followup where part_id=${ids.part}::uuid and kind='low_result_action'`);
  expect(row.actor).toBe(peer.userId);
 });

 it('Approve and release letters: opens the letter owners to a member in scope only',async()=>{
  const fixture=probationOutcomeFixture(b,admin),{decision,peer}=await fixture.recordedConfirm();admin=fixture.admin();
  await expect(probationLetterTemplateChoices(peer.ctx,decision.id)).rejects.toThrow();
  const granted=await grantRole(admin,['cases.letters'],peer.userId,{companyId:b.companyId,validTo:addDaysIso(today,-1)});
  await expect(probationLetterTemplateChoices(peer.ctx,decision.id)).rejects.toThrow();
  await changeProbationAccessMember(admin,{memberId:granted.memberId,businessGroupId:null,companyId:b.companyId,validFrom:'2026-01-01',validTo:null});
  expect(await probationLetterTemplateChoices(peer.ctx,decision.id)).toBeTruthy();
 });

 it('Change a case\'s route: a member may change an unsubmitted route; a viewer may not',async()=>{
  const fixture=probationFormCaseFixture(b,admin),{ids,stored}=await fixture.caseWithRows([]);admin=fixture.admin();
  const peer=await fixture.person('Fictional Route Keeper');
  const before=await stored();
  await grantRole(admin,['cases.view'],peer.userId,{companyId:b.companyId});
  await expect(overrideProbationRoute(peer.ctx,{partId:ids.part,revision:before.revision,route:before.route,reason:'Fictional route change'})).rejects.toThrow();
  await grantRole(admin,['cases.route'],peer.userId,{businessGroupId:b.companyId});
  await overrideProbationRoute(peer.ctx,{partId:ids.part,revision:before.revision,route:before.route,reason:'Fictional route change'});
  expect((await stored()).override).toBe(true);
 });
});

describe('Direct Superiors rule',()=>{
 it('gives the Direct Superior their own team\'s cases only, and follows the rule when it is changed',async()=>{
  const fixture=probationFormCaseFixture(b,admin),{ids,staff,manager}=await fixture.caseWithRows([]);admin=fixture.admin();
  const peer=await fixture.person('Fictional Other Manager'); // the fixture's own peer heads the department
  expect(await caseAccess(manager.ctx,ids.caseId)).toBe(true);expect(await role(manager.ctx,staff.employmentId,'lm')).toBe(true);
  // Another person's Direct Superior (here nobody's) sees nothing.
  expect(await caseAccess(peer.ctx,ids.caseId)).toBe(false);expect(await role(peer.ctx,staff.employmentId,'lm')).toBe(false);
  // View off: the Line Manager keeps their steps but no longer sees the case through the rule.
  await saveProbationSuperiorRule(admin,{enabled:true,view:false,recordDeclined:true,expectedRevision:0});
  expect(await caseAccess(manager.ctx,ids.caseId)).toBe(false);expect(await role(manager.ctx,staff.employmentId,'lm')).toBe(true);
  // Rule off: no Line Manager role at all.
  await saveProbationSuperiorRule(admin,{enabled:false,view:true,recordDeclined:true,expectedRevision:1});
  expect(await caseAccess(manager.ctx,ids.caseId)).toBe(false);expect(await role(manager.ctx,staff.employmentId,'lm')).toBe(false);
  // Back on restores today's behaviour; the rule never gives settings rights.
  await saveProbationSuperiorRule(admin,{enabled:true,view:true,recordDeclined:true,expectedRevision:2});
  expect(await caseAccess(manager.ctx,ids.caseId)).toBe(true);expect(await configAdmin(manager.ctx,b.companyId)).toBe(false);
  expect(await probationNavigationAccess(manager.ctx)).toMatchObject({configure:false,intake:false,access:false});
 });

 it('records a declined signature only while the rule allows it',async()=>{
  const fixture=probationFormCaseFixture(b,admin),{ids,manager,prepare,submit}=await fixture.caseWithRows([{id:'hod',order:1,action:'review',who:'hod'},{id:'pbp',order:2,action:'approve_sign',who:'pbp'}]);admin=fixture.admin();
  await prepare();await submit();
  // Through the real command (app.probation_signing_access is owner-only): refused while the rule withholds it, then
  // recorded once the rule allows it again.
  const part=async()=>(await probationCase(manager.ctx,ids.caseId)).parts.find(p=>p.id===ids.part)!;
  const decline=async()=>actOnProbation(manager.ctx,{caseId:ids.caseId,partId:ids.part,revision:(await part()).revision,command:'request_refusal',reason:'Fictional employee declined to sign'});
  await saveProbationSuperiorRule(admin,{enabled:true,view:true,recordDeclined:false,expectedRevision:0});
  await expect(decline()).rejects.toThrow();
  await saveProbationSuperiorRule(admin,{enabled:true,view:true,recordDeclined:true,expectedRevision:1});
  await expect(decline()).resolves.toBeDefined();
 });
});

describe('Settings permissions',()=>{
 it('Configure probation: per company for a scoped member; the group standard and builders need all companies',async()=>{
  const plain=await outsider('Fictional configurator');
  const other=await createCompany(admin,{legalName:'Fictional Configured Elsewhere Sdn Bhd',country:'MY',currency:'MYR'});
  expect(await configAdmin(plain.ctx,b.companyId)).toBe(false);
  await grantRole(admin,['settings.configure'],plain.userId,{companyId:b.companyId});
  expect(await configAdmin(plain.ctx,b.companyId)).toBe(true);expect(await configAdmin(plain.ctx,other.id)).toBe(false);
  expect(await probationNavigationAccess(plain.ctx)).toMatchObject({page:true,configure:true});
  const tenantWide=(ctx:SessionContext)=>withTenant(ctx,async tx=>(await tx.execute<{scope:boolean;builders:boolean}>(sql`select app.probation_settings_scope_admin() as scope,app.automation_can_configure('probation') as builders`))[0]);
  expect(await tenantWide(plain.ctx)).toEqual({scope:false,builders:false});
  await grantRole(admin,['settings.configure'],plain.userId);
  expect(await tenantWide(plain.ctx)).toEqual({scope:true,builders:true});
 });

 it('Intake and activation: lists the member\'s companies for intake and nothing else',async()=>{
  const plain=await outsider('Fictional intake lead');
  const other=await createCompany(admin,{legalName:'Fictional Intake Elsewhere Sdn Bhd',country:'MY',currency:'MYR'});
  expect(await probationIntakeCompanies(plain.ctx)).toEqual([]);
  await grantRole(admin,['settings.intake'],plain.userId,{companyId:b.companyId});
  expect((await probationIntakeCompanies(plain.ctx)).map(c=>({id:c.id,canPrepare:c.canPrepare}))).toEqual([{id:b.companyId,canPrepare:true}]);
  expect(await probationNavigationAccess(plain.ctx)).toMatchObject({intake:true,configure:false});
  expect(await configAdmin(plain.ctx,b.companyId)).toBe(false);void other;
 });

 it('Approve Personnel postings: decides who may choose the posting-approver group; configuring alone may not',async()=>{
  const plain=await outsider('Fictional settings editor');
  await grantRole(admin,['settings.configure'],plain.userId);
  const {version:_v,gradeHFormPublished:_g,...standard}=DEFAULT_PROBATION_CONFIG as typeof DEFAULT_PROBATION_CONFIG&{gradeHFormPublished?:boolean};void _v;void _g;
  const first=await saveProbationSettingsScope(plain.ctx,{settingKey:null,scope:'standard',name:'Group standard',companyIds:[],data:standard as never,publish:false,expectedVersion:0});
  const withGroup={...standard,postingApproverGroupId:'probation-people'};
  await expect(saveProbationSettingsScope(plain.ctx,{settingKey:first.settingKey,scope:'standard',name:'Group standard',companyIds:[],data:withGroup as never,publish:false,expectedVersion:1})).rejects.toMatchObject({code:'forbidden'});
  await grantRole(admin,['settings.postings'],plain.userId);
  const second=await saveProbationSettingsScope(plain.ctx,{settingKey:first.settingKey,scope:'standard',name:'Group standard',companyIds:[],data:withGroup as never,publish:false,expectedVersion:1});
  expect(second.version).toBe(2);
  // The tenant-level Probation module permission keeps it, as today.
  await saveProbationSettingsScope(admin,{settingKey:first.settingKey,scope:'standard',name:'Group standard',companyIds:[],data:{...withGroup,postingApproverGroupId:'another-group'} as never,publish:false,expectedVersion:2});
 });
});

describe('leakage',()=>{
 it('never reaches another tenant: no case, permission, view or scope across tenants',async()=>{
  const fixture=probationFormCaseFixture(b,admin),{ids}=await fixture.caseWithRows([]);admin=fixture.admin();
  const peer=await fixture.person('Fictional Member');
  const foreign=await seedBase();await setModule(foreign.tenantId,'lifecycle','active');const foreignAdmin=adminCtx(foreign);
  await grantRole(admin,['cases.view','cases.letters','cases.low_result','cases.route','settings.configure','settings.intake','settings.postings'],peer.userId);
  // The same login presented under the other tenant holds nothing there, and the foreign administrator sees nothing here.
  const forged={...foreignAdmin,userId:peer.userId,personId:peer.personId,roles:['employee'],grants:undefined} as SessionContext;
  expect(await caseAccess(forged,ids.caseId)).toBe(false);expect(await configAdmin(forged,foreign.companyId)).toBe(false);
  expect(await caseAccess(foreignAdmin,ids.caseId)).toBe(false);
  expect((await probationAccessView(foreignAdmin))!.roles).toEqual([]);
  const visible=await withTenant(foreignAdmin,tx=>tx.execute<{id:string}>(sql`select app.probation_visible_case_ids() as id`));
  expect(visible.map(r=>r.id)).not.toContain(ids.caseId);
  // A member cannot be scoped to another tenant's company or group, nor be another tenant's login.
  const made=await saveProbationAccessRole(admin,{roleId:null,name:'Fictional cross-tenant check',permissions:['cases.view'],expectedRevision:0});
  await expect(addProbationAccessMember(admin,{roleId:made.id,userId:peer.userId,businessGroupId:null,companyId:foreign.companyId,validFrom:'2026-01-01',validTo:null})).rejects.toMatchObject({code:'invalid'});
  await expect(addProbationAccessMember(admin,{roleId:made.id,userId:peer.userId,businessGroupId:foreign.companyId,companyId:null,validFrom:'2026-01-01',validTo:null})).rejects.toMatchObject({code:'invalid'});
  await expect(addProbationAccessMember(admin,{roleId:made.id,userId:foreign.adminUserId,businessGroupId:null,companyId:null,validFrom:'2026-01-01',validTo:null})).rejects.toMatchObject({code:'invalid'});
  await expect(saveProbationAccessRole(foreignAdmin,{roleId:made.id,name:'Taken over',permissions:['cases.view'],expectedRevision:1})).rejects.toMatchObject({code:'invalid'});
 });
});
