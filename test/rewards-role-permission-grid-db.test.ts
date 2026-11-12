/** Board db14e49c: the Role permissions grid against the real database. Catalogue parity between TypeScript and SQL,
 * batch saves (all or nothing, stale revisions, locked and above-default cells refused by the command and by the
 * database), the self rule, HR Admin and whole-group CTRO saving immediately, a proposer's batch waiting for an
 * independent checker, lapsed batches, legacy rows, tenant isolation, the export, and the formerly display-only rows
 * narrowing the server (libraries, Senior plan amounts, menus). Fictional tenant data only. */
import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,describe,it,expect} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {adminCtx,createAppUser,setModule,owner,migrateTestDb,resetDb,seedBase,closeAll,entitledCtx,type Base} from './harness';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {setCompensation} from '../core/comp';
import {createApprovedRewardUnit} from './rewards-setup-fixture';
import {rewardAccessRoles,rewardPermissionCatalogue,rewardDefaultLevel,rewardLevelOptions,rewardCellLock} from '../packs/rewards/access-policy-model';
import {rewardRolePermissionGrid,previewRewardRolePermissionBatch,saveRewardRolePermissionBatch,decideRewardRolePermissionRequest,rewardRolePermissionAuditRows,rewardRolePermissionEntry} from '../packs/rewards/role-permission-grid';
import {rewardNavigation} from '../packs/rewards/access-policy';
import {rewardLimitControlsAccessTx} from '../packs/rewards/limit-controls';
import {pgSqlState} from '../lib/db-error';
import {todayInKualaLumpur} from '../lib/hr-date';

const today=todayInKualaLumpur(),year=Number(today.slice(0,4));
let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'rewards','active');});

type Change={role:(typeof rewardAccessRoles)[number];capability:string;after:'full'|'step'|'view'|'none'};
async function person(name:string){
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@role-grid.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',employeeCode:'RG-'+randomUUID().slice(0,6),hiredOn:'2024-01-01'});
 const userId=await createAppUser(b.tenantId,hired.personId,'employee');
 return{...adminCtx(b),userId,personId:hired.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]} as SessionContext&{personId:string};
}
/** Group Rewards with group-level setup authority. */
async function groupRewards(name='Fictional Group Rewards editor'){const ctx=await person(name);await owner.db.execute(sql`insert into reward_setup_grant(tenant_id,user_id,role,valid_from,created_by,reason) values(${b.tenantId}::uuid,${ctx.userId}::uuid,'gr','2000-01-01',${b.adminUserId}::uuid,'Fictional group setup authority')`);return ctx;}
/** A whole-group CTRO. */
async function wholeGroupCtro(name='Fictional whole-group CTRO'){const ctx=await person(name);await owner.db.execute(sql`insert into reward_group_role_grant(tenant_id,user_id,role,active,revision) values(${b.tenantId}::uuid,${ctx.userId}::uuid,'ctro',true,1)`);return ctx;}
async function save(ctx:SessionContext,changes:Change[],reason='Fictional permission batch reason',extra:Record<string,unknown>={}){
 const grid=await rewardRolePermissionGrid(ctx);const preview=await previewRewardRolePermissionBatch(ctx,{baseRevision:grid.revision,changes,reason,...extra});
 return saveRewardRolePermissionBatch(ctx,{baseRevision:grid.revision,changes,reason,digest:preview.digest,...extra});
}
const stored=()=>owner.db.execute<{role:string;capability:string;level:string;allowed:boolean;changed_by:string}>(sql`select role,capability,level,allowed,changed_by from reward_role_permission where tenant_id=${b.tenantId}::uuid order by role,capability`);
const versions=()=>owner.db.execute<{revision:number;action:string;saved_by:string;matrix:Record<string,string>;changes:unknown[];restored_from:number|null;request_id:string|null}>(sql`select revision,action,saved_by,matrix,changes,restored_from,request_id from reward_role_permission_version where tenant_id=${b.tenantId}::uuid order by revision`);
async function errorOf(promise:Promise<unknown>){return promise.then(()=>null,error=>error as {code?:string;message:string});}

describe('Role permissions grid (database)',()=>{
 it('mirrors the TypeScript catalogue in SQL for every role and row: default, options and lock',async()=>{
  const pairs=rewardPermissionCatalogue.filter(r=>r.editable).flatMap(row=>rewardAccessRoles.map(role=>({role,capability:row.id})));
  const rows=await owner.db.execute<{role:string;capability:string;d:string;options:string[];locked:boolean}>(sql`select x.role,x.capability,app.reward_role_default_level(x.role,x.capability) as d,app.reward_role_level_options(x.role,x.capability) as options,app.reward_role_permission_locked(x.role,x.capability) as locked
   from jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) as x(role text,capability text)`);
  expect(rows).toHaveLength(pairs.length);
  for(const r of rows){const role=r.role as Change['role'],capability=r.capability as Parameters<typeof rewardDefaultLevel>[1];
   expect({cell:`${role}:${capability}`,d:r.d,options:r.options,locked:r.locked}).toEqual({cell:`${role}:${capability}`,d:rewardDefaultLevel(role,capability),options:rewardLevelOptions(role,capability),locked:rewardCellLock(role,capability)!==null});}
  // The unit capabilities keep their boolean meaning: default <> none exactly where the native capability is on.
  const native=await owner.db.execute<{n:number}>(sql`select count(*)::int as n from jsonb_to_recordset(${JSON.stringify(pairs)}::jsonb) as x(role text,capability text)
   where x.capability in('review.view','analytics.view','approvals.view','rules.view','figures.edit','cases.decide','notes.add','review.decide','review.batch','offcycle.raise','offcycle.decide','data.check','snapshot.refresh')
    and (app.reward_role_default_level(x.role,x.capability)<>'none') is distinct from app.reward_role_native_capability(case when x.role='proxy_bg' then 'bg' else x.role end,x.capability)`);
  expect(native[0].n).toBe(0);
 });

 it('lets HR Admin save a batch at once: one version, levels with allowed kept in step, one change-log row',async()=>{
  const hr=adminCtx(b);
  expect(await rewardRolePermissionEntry(hr)).toEqual({reader:true,immediate:true,proposer:false});
  const result=await save(hr,[{role:'bu',capability:'review.view',after:'none'},{role:'gr',capability:'salary.view',after:'view'},{role:'proxy_bg',capability:'offcycle.decide',after:'none'}],'Fictional narrowing for the pilot');
  expect(result).toEqual({mode:'applied',revision:1});
  expect((await stored()).map(r=>[r.role,r.capability,r.level,r.allowed,r.changed_by])).toEqual([['bu','review.view','none',false,hr.userId],['gr','salary.view','view',true,hr.userId],['proxy_bg','offcycle.decide','none',false,hr.userId]]);
  const [v]=await versions();
  expect(v).toMatchObject({revision:1,action:'saved',saved_by:hr.userId,matrix:{'bu:review.view':'none','gr:salary.view':'view','proxy_bg:offcycle.decide':'none'}});
  const log=await owner.db.execute<{action:string;actor_id:string;version_ref:string;high_impact:boolean;summary:{lines:{label:string;before:string;after:string}[]}}>(sql`select action,actor_id,version_ref,high_impact,summary from reward_config_change where tenant_id=${b.tenantId}::uuid and area='role_permission'`);
  expect(log.map(r=>[r.action,r.actor_id,r.version_ref,r.high_impact])).toEqual([['batch-saved',hr.userId,'1',true]]);
  expect(log[0].summary.lines.map(l=>`${l.label}: ${l.before} → ${l.after}`)).toEqual(['BU CEO · Reviewing Team Rewards: View only → —','Group Rewards · Salary Structures: Full → View only','Proxy BG CEO · Approve off-cycle request: At their step → —']);
  // Setting a cell back to its default removes the row.
  await save(hr,[{role:'bu',capability:'review.view',after:'view'}]);
  expect((await stored()).map(r=>`${r.role}:${r.capability}`)).toEqual(['gr:salary.view','proxy_bg:offcycle.decide']);
  expect((await versions()).map(v=>v.revision)).toEqual([1,2]);
 },60_000);

 it('saves all cells or none: a locked cell, an above-default cell or a stale revision changes nothing',async()=>{
  const hr=adminCtx(b);
  const locked=await errorOf(save(hr,[{role:'bu',capability:'review.view',after:'none'},{role:'gr',capability:'access.manage',after:'none'}]));
  expect(locked?.code).toBe('locked');
  const wider=await errorOf(save(hr,[{role:'bu',capability:'review.view',after:'none'},{role:'ctro',capability:'salary.view',after:'full'}]));
  expect(wider?.code).toBe('invalid');
  const fixed=await errorOf(save(hr,[{role:'bu',capability:'own.never',after:'none'}]));
  expect(fixed?.code).toBe('invalid');
  expect(await stored()).toEqual([]);expect(await versions()).toEqual([]);
  await save(hr,[{role:'ctro',capability:'bonus.view',after:'none'}]);
  const stale=await errorOf(saveRewardRolePermissionBatch(hr,{baseRevision:0,changes:[{role:'bu',capability:'review.view',after:'none'}],reason:'Saved against an old revision'}));
  expect(stale?.code).toBe('stale');
  expect((await stored()).map(r=>`${r.role}:${r.capability}`)).toEqual(['ctro:bonus.view']);
  // The database refuses the same cells without the command.
  for(const raw of [sql`'gr','access.manage','none'`,sql`'ctro','salary.view','full'`,sql`'bu','own.never','none'`,sql`'bu','review.decide','none'`]){
   const error=await errorOf(withTenant(hr,tx=>tx.execute(sql`insert into reward_role_permission(tenant_id,role,capability,level,allowed,changed_by,reason) values(app.current_tenant_id(),${raw},false,app.current_user_id(),'Raw write around the command')`)));
   expect(pgSqlState(error)).toBe('42501');
  }
 },60_000);

 it('applies the self rule: nobody changes the switches for a role they hold',async()=>{
  const gr=await groupRewards(),ctro=await wholeGroupCtro();
  expect((await rewardRolePermissionGrid(gr)).heldRoles).toEqual(['gr']);
  expect((await errorOf(save(gr,[{role:'gr',capability:'figures.edit',after:'none'}])))?.code).toBe('held');
  expect((await errorOf(save(ctro,[{role:'ctro',capability:'bonus.view',after:'none'}])))?.code).toBe('held');
  // CTRO (whole group) saves another role's cells immediately, and Group Rewards can narrow CTRO.
  expect(await save(ctro,[{role:'gr',capability:'pat.manage',after:'none'}])).toEqual({mode:'applied',revision:1});
  expect(await save(gr,[{role:'ctro',capability:'senior.manage',after:'none'}])).toEqual({mode:'applied',revision:2});
  const raw=await errorOf(withTenant(gr,tx=>tx.execute(sql`insert into reward_role_permission(tenant_id,role,capability,level,allowed,changed_by,reason) values(app.current_tenant_id(),'gr','notes.add','none',false,app.current_user_id(),'Raw own-role write attempt')`)));
  expect(raw).not.toBeNull();
 },60_000);

 it('keeps a proposer batch waiting until an independent checker approves; the proposer cannot decide it',async()=>{
  const hr=adminCtx(b),gr=await entitledCtx(b);
  const [bu]=await owner.db.insert(schema.businessUnit).values({tenantId:b.tenantId,companyId:b.companyId,code:'RG',name:'Fictional grid unit'}).returning();
  const subject=await hireEmployee(gr,{person:{fullName:'Fictional reviewee',primaryEmail:randomUUID()+'@role-grid.test'},companyId:b.companyId,departmentId:b.deptA,businessUnitId:bu.id,employmentType:'full_time',hiredOn:`${year-2}-01-01`});
  await setCompensation(gr,{employmentId:subject.employmentId,basicSalary:5000,effectiveFrom:`${year-2}-01-01`});
  await owner.db.update(schema.employment).set({confirmationDate:`${year-2}-04-01`}).where(eq(schema.employment.id,subject.employmentId));
  const unitId=await createApprovedRewardUnit(gr,{name:'Fictional grid review',year,companyId:b.companyId,businessUnitId:bu.id,snapshotDate:today});
  const [p]=await owner.db.insert(schema.person).values({tenantId:b.tenantId,fullName:'Fictional company Group Rewards',primaryEmail:randomUUID()+'@role-grid.test'}).returning();
  const proposerId=await createAppUser(b.tenantId,p.id,'employee');
  await owner.db.insert(schema.rewardMember).values({tenantId:b.tenantId,unitId,userId:proposerId,role:'gr'});
  const proposer={...gr,userId:proposerId,personId:p.id,roles:['employee'],grants:[{role:'employee',companyId:null}]} as SessionContext;
  expect(await rewardRolePermissionEntry(proposer)).toEqual({reader:true,immediate:false,proposer:true});
  const sent=await save(proposer,[{role:'pbp',capability:'rules.view',after:'none'}],'PBP no longer needs the rules page');
  expect(sent.mode).toBe('requested');
  expect(await stored()).toEqual([]);
  const requestId=(sent as {requestId:string}).requestId;
  expect((await errorOf(decideRewardRolePermissionRequest(proposer,{requestId,approve:true})))?.code).toBe('forbidden');
  // A direct decision by the proposer matches no row under row security.
  expect(await withTenant(proposer,tx=>tx.execute(sql`update reward_role_permission_request set status='applied',decided_by=app.current_user_id(),decided_at=now(),applied_revision=1 where id=${requestId}::uuid returning id`))).toHaveLength(0);
  const grid=await rewardRolePermissionGrid(hr);
  expect(grid.requests.map(r=>[r.status,r.canDecide,r.changes])).toEqual([['pending',true,[{role:'pbp',capability:'rules.view',before:'view',after:'none'}]]]);
  expect(await decideRewardRolePermissionRequest(hr,{requestId,approve:true})).toEqual({status:'applied',revision:1});
  expect((await stored()).map(r=>[r.role,r.capability,r.level,r.changed_by])).toEqual([['pbp','rules.view','none',hr.userId]]);
  expect((await versions()).map(v=>[v.revision,v.action,v.request_id])).toEqual([[1,'approved',requestId]]);
  // A batch proposed before the grid changed lapses instead of overwriting the newer save.
  const stale=await save(proposer,[{role:'payroll',capability:'rules.view',after:'none'}],'Payroll no longer needs the rules page');
  await save(hr,[{role:'bu',capability:'analytics.view',after:'none'}]);
  expect(await decideRewardRolePermissionRequest(hr,{requestId:(stale as {requestId:string}).requestId,approve:true})).toEqual({status:'lapsed'});
  expect((await stored()).some(r=>r.role==='payroll')).toBe(false);
  // Rejecting needs a reason.
  const third=await save(proposer,[{role:'payroll',capability:'rules.view',after:'none'}],'Payroll no longer needs the rules page');
  expect((await errorOf(decideRewardRolePermissionRequest(hr,{requestId:(third as {requestId:string}).requestId,approve:false,reason:'no'})))?.code).toBe('reason');
  expect(await decideRewardRolePermissionRequest(hr,{requestId:(third as {requestId:string}).requestId,approve:false,reason:'Payroll still checks the rules page'})).toEqual({status:'rejected'});
  // The export lists the saved, approved, waiting and decided batches.
  const audit=await rewardRolePermissionAuditRows(hr);
  expect(audit.map(r=>[r[5],r[6],r[7]])).toEqual(expect.arrayContaining([
   ['PBP (read only) · Rules: View only','PBP (read only) · Rules: —','batch-approved'],
   ['Payroll · Rules: View only','Payroll · Rules: —','batch-lapsed'],
   ['Payroll · Rules: View only','Payroll · Rules: —','batch-rejected'],
   ['BU CEO · Rewards Analytics: View only','BU CEO · Rewards Analytics: —','batch-saved'],
  ]));
  // Narrowing Promotion nominations for Group Rewards removes the menu and the page for that seat.
  // (The fixture's HR Admin also holds a Group Rewards seat on this review, so a whole-group CTRO narrows it.)
  expect(await rewardNavigation(proposer)).toContain('/rewards/promotions');
  await save(await wholeGroupCtro(),[{role:'gr',capability:'promotions.view',after:'none'}]);
  expect(await rewardNavigation(proposer)).not.toContain('/rewards/promotions');
  // Senior plan amounts: a CTRO seat reads them at View only and loses them at —.
  const ctro=await person('Fictional unit CTRO');
  await owner.db.insert(schema.rewardMember).values({tenantId:b.tenantId,unitId,userId:ctro.userId!,role:'ctro'});
  const [entry]=await owner.db.select().from(schema.rewardEntry).where(eq(schema.rewardEntry.unitId,unitId));
  await owner.db.execute(sql`insert into reward_senior_award(entry_id,tenant_id,unit_id,award) values(${entry.id}::uuid,${b.tenantId}::uuid,${unitId}::uuid,'{"fictional":true}'::jsonb)`);
  const seniorRows=()=>withTenant(ctro,tx=>tx.execute<{entry_id:string}>(sql`select entry_id from reward_senior_award where unit_id=${unitId}::uuid`));
  expect((await seniorRows()).map(r=>r.entry_id)).toEqual([entry.id]);
  await save(hr,[{role:'ctro',capability:'senior.manage',after:'none'}]);
  expect(await seniorRows()).toEqual([]);
 },180_000);

 it('narrows the configuration pages for real: CTRO loses Bonus Matrices, Group Rewards keeps a read-only salary page',async()=>{
  const hr=adminCtx(b),gr=await groupRewards(),ctro=await wholeGroupCtro();
  for(const kind of ['salary','bonus'])await owner.db.execute(sql`insert into reward_library(tenant_id,kind,name,year,created_by) values(${b.tenantId}::uuid,${kind},${'Fictional '+kind},${year},${b.adminUserId}::uuid)`);
  const kinds=(ctx:SessionContext)=>withTenant(ctx,tx=>tx.execute<{kind:string}>(sql`select kind from reward_library order by kind`)).then(rows=>rows.map(r=>r.kind));
  expect(await kinds(ctro)).toEqual(['bonus','salary']);
  expect(await rewardNavigation(ctro)).toEqual(expect.arrayContaining(['/admin/rewards/salary-structures','/admin/rewards/bonus-matrices','/admin/rewards/access']));
  await save(hr,[{role:'ctro',capability:'bonus.view',after:'none'},{role:'gr',capability:'salary.view',after:'view'}]);
  expect(await kinds(ctro)).toEqual(['salary']);
  const nav=await rewardNavigation(ctro);expect(nav).toContain('/admin/rewards/salary-structures');expect(nav).not.toContain('/admin/rewards/bonus-matrices');
  const page=await withTenant(ctro,tx=>tx.execute<{v:boolean}>(sql`select app.reward_setup_page_allowed(null,'bonus.view','library_view') as v`));expect(page[0].v).toBe(false);
  // Group Rewards still reads salary structures but can no longer write them.
  expect(await kinds(gr)).toEqual(['bonus','salary']);
  const write=await errorOf(withTenant(gr,tx=>tx.execute(sql`insert into reward_library(tenant_id,kind,name,year,created_by) values(app.current_tenant_id(),'salary','Fictional blocked',${year},app.current_user_id())`)));
  expect(write).not.toBeNull();
  await withTenant(gr,tx=>tx.execute(sql`insert into reward_library(tenant_id,kind,name,year,created_by) values(app.current_tenant_id(),'bonus','Fictional allowed bonus',${year},app.current_user_id())`));
 },90_000);

 it('narrows Limit Controls through its row: CTRO loses the page and its rows, Group Rewards drops to read-only',async()=>{
  const hr=adminCtx(b),gr=await groupRewards(),ctro=await wholeGroupCtro();
  const access=(ctx:SessionContext)=>withTenant(ctx,tx=>rewardLimitControlsAccessTx(tx));
  const versionsSeen=(ctx:SessionContext)=>withTenant(ctx,tx=>tx.execute<{revision:number}>(sql`select revision from reward_limit_version order by revision`)).then(rows=>rows.map(r=>r.revision));
  const insertVersion=(ctx:SessionContext,revision:number)=>withTenant(ctx,tx=>tx.execute(sql`insert into reward_limit_version(tenant_id,year,revision,limit_values,reason,created_by) values(app.current_tenant_id(),${year},${revision},'{"fictional":true}'::jsonb,'Fictional limit decision for the grid test',app.current_user_id())`));
  // Defaults: Group Rewards edits, CTRO views.
  expect(await access(gr)).toBe('edit');expect(await access(ctro)).toBe('view');
  await insertVersion(gr,1);
  expect(await versionsSeen(ctro)).toEqual([1]);
  expect(await rewardNavigation(ctro)).toContain('/admin/rewards/limit-controls');
  // HR Admin narrows both cells in one batch.
  await save(hr,[{role:'ctro',capability:'limits.view',after:'none'},{role:'gr',capability:'limits.view',after:'view'}],'Fictional Limit Controls narrowing');
  expect(await access(ctro)).toBeNull();
  expect(await versionsSeen(ctro)).toEqual([]);
  expect(await rewardNavigation(ctro)).not.toContain('/admin/rewards/limit-controls');
  expect(await access(gr)).toBe('view');
  expect(await versionsSeen(gr)).toEqual([1]);
  expect(await rewardNavigation(gr)).toContain('/admin/rewards/limit-controls');
  const blocked=await errorOf(insertVersion(gr,2));
  expect(pgSqlState(blocked)).toBe('42501');
  // Back to the default: Group Rewards edits again.
  await save(hr,[{role:'gr',capability:'limits.view',after:'full'}]);
  expect(await access(gr)).toBe('edit');
  await insertVersion(gr,2);
  expect(await versionsSeen(gr)).toEqual([1,2]);
  expect(await access(ctro)).toBeNull();
 },90_000);

 it('reads legacy one-cell rows as levels, keeps another tenant isolated and refuses View as',async()=>{
  const hr=adminCtx(b);
  // A row written the old way (allowed only) becomes a level through the shape trigger.
  await withTenant(hr,tx=>tx.execute(sql`insert into reward_role_permission(tenant_id,role,capability,allowed,changed_by,reason) values(app.current_tenant_id(),'bg','notes.add',false,app.current_user_id(),'Legacy one-cell switch')`));
  expect((await stored()).map(r=>[r.role,r.capability,r.level,r.allowed])).toEqual([['bg','notes.add','none',false]]);
  expect((await rewardRolePermissionGrid(hr)).matrix).toEqual({'bg:notes.add':'none'});
  const other=await seedBase();await setModule(other.tenantId,'rewards','active');
  const otherHr=adminCtx(other);
  expect((await rewardRolePermissionGrid(otherHr)).matrix).toEqual({});
  await save(otherHr,[{role:'bu',capability:'review.view',after:'none'}]);
  expect((await rewardRolePermissionGrid(hr)).matrix).toEqual({'bg:notes.add':'none'});
  expect((await rewardRolePermissionGrid(hr)).versions).toEqual([]);
  const crossTenant=await withTenant(hr,tx=>tx.execute(sql`select count(*)::int as n from reward_role_permission_version`));expect(crossTenant[0]).toEqual({n:0});
 },90_000);
});
