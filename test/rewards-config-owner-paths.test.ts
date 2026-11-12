/** Board 60f1fdcd, owner-owned configuration paths (migration 5580): CTRO and HR Admin edit Salary Structures, Bonus
 * Matrices and company PAT within the companies they look after; group-wide items need group-wide authority; other
 * roles and other tenants are refused; notices reach the other editors, HR Admin included, never the editor. The
 * plan activator's review creation and the uploader's activation are covered in rewards-setup-owner and
 * rewards-approved-review-db. Fictional tenant data only. */
import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {adminCtx,createAppUser,setModule,owner,migrateTestDb,resetDb,seedBase,closeAll,type Base} from './harness';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {saveRewardLibrary,rewardLibraries,rewardLibraryPageAccess} from '../packs/rewards/libraries';
import {saveRewardPatBatch,rewardPatInputs} from '../packs/rewards/pat-inputs';
import {rewardConfigChangeLog} from '../packs/rewards/config-change';
import {rolePermission} from '../packs/rewards/access-policy-model';
import {rewardNavigation} from '../packs/rewards/access-policy';
import {setupGrades} from './rewards-setup-fixture';

let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'rewards','active');});

type Actor=SessionContext&{personId:string};
async function hired(base:Base,name:string){
 const h=await hireEmployee(adminCtx(base),{person:{fullName:name,primaryEmail:randomUUID()+'@config-owner.test'},companyId:base.companyId,departmentId:base.deptA,employmentType:'full_time',employeeCode:'CO-'+randomUUID().slice(0,6),hiredOn:'2024-01-01'});
 return h;
}
/** A CTRO with a group-level setup grant (one of the CTRO authority sources). */
async function ctro(base:Base,name='Fictional CTRO'):Promise<Actor>{
 const h=await hired(base,name),userId=await createAppUser(base.tenantId,h.personId,'employee');
 await owner.db.execute(sql`insert into reward_setup_grant(tenant_id,user_id,role,valid_from,created_by,reason) values(${base.tenantId}::uuid,${userId}::uuid,'ctro','2000-01-01',${base.adminUserId}::uuid,'Fictional CTRO configuration editor')`);
 return{...adminCtx(base),userId,personId:h.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
}
/** An HR Admin: group-wide (company null) or over one company. */
async function hrAdmin(base:Base,companyId:string|null,name:string):Promise<Actor>{
 const h=await hired(base,name),userId=await createAppUser(base.tenantId,h.personId,'employee');
 await owner.db.insert(schema.roleAssignment).values({tenantId:base.tenantId,appUserId:userId,companyId,role:'hr_admin'});
 return{...adminCtx(base),userId,personId:h.personId,roles:['employee','hr_admin'],grants:[{role:'employee',companyId:null},{role:'hr_admin',companyId}]};
}
async function employee(base:Base,name:string):Promise<Actor>{
 const h=await hired(base,name),userId=await createAppUser(base.tenantId,h.personId,'employee');
 return{...adminCtx(base),userId,personId:h.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
}
const salaryData=(grades:{gradeId:string;grade:string}[],scale=1)=>({kind:'salary' as const,rows:grades.map(g=>({...g,minimumCents:g.grade==='23'?null:10000*scale,midpointCents:g.grade==='23'?null:20000*scale,maximumCents:g.grade==='23'?null:30000*scale}))});
const salaryRaw=(name:string,grades:{gradeId:string;grade:string}[],scale=1)=>({libraryId:null,versionId:null,expectedLock:0,name,year:2026,tags:[],groupDefault:false,previousLibraryId:null,data:salaryData(grades,scale),reason:'Board 60f1fdcd owner-path library save',mode:'active' as const});
const pat={targetCents:1_000_000,forecastCents:null,actualCents:900_000,targetMonthsBp:20000};
const jobOf=async(userId:string|undefined)=>(await owner.db.execute<{id:string}>(sql`select e.id from employment e join app_user u on u.person_id=e.person_id and u.tenant_id=e.tenant_id where u.id=${userId!}::uuid`))[0].id;

it('shows CTRO and HR Admin as Full on Salary Structures, Bonus Matrices and PAT Inputs, and leaves other pages unchanged',()=>{
 for(const capability of ['salary.view','bonus.view','pat.manage'] as const)for(const role of ['gr','ctro','hr_admin'] as const)expect(rolePermission(role,capability)).toBe('full');
 for(const role of ['bu','bg','ec','pbp','payroll'] as const)expect(rolePermission(role,'pat.manage')).toBe('none');
 expect(rolePermission('ctro','plans.manage')).toBe('none');expect(rolePermission('hr_admin','senior.manage')).toBe('none');
 expect(rolePermission('hr_admin','review.decide')).toBe('none');
});

it('lets CTRO and a group-wide HR Admin save and make salary structures active, and refuses a company-scoped HR Admin and other roles',async()=>{
 const c=await ctro(b),hr=await hrAdmin(b,null,'Fictional group HR Admin'),scoped=await hrAdmin(b,b.companyId,'Fictional company HR Admin'),staff=await employee(b,'Fictional employee');
 const grades=await setupGrades(c);
 expect((await rewardLibraryPageAccess(c)).canManage).toBe(true);expect((await rewardLibraryPageAccess(hr)).canManage).toBe(true);
 const byCtro=await saveRewardLibrary(c,salaryRaw('CTRO Salary',grades));
 const byHr=await saveRewardLibrary(hr,salaryRaw('HR Admin Salary',grades,2));
 const versions=await owner.db.execute<{id:string;state:string;confirmed_by:string;created_by:string}>(sql`select id,state,confirmed_by,created_by from reward_library_version where id in(${byCtro}::uuid,${byHr}::uuid) order by created_at`);
 expect(versions.map(v=>[v.id,v.state,v.created_by,v.confirmed_by])).toEqual([[byCtro,'confirmed',c.userId,c.userId],[byHr,'confirmed',hr.userId,hr.userId]]);
 // The private revision history and the change log record the editor.
 const audit=await owner.db.execute<{actor_id:string;after_state:string}>(sql`select actor_id,after_state from reward_library_revision_audit where version_id=${byHr}::uuid order by lock_version`);
 expect(audit.map(a=>[a.actor_id,a.after_state])).toEqual([[hr.userId,'draft'],[hr.userId,'confirmed']]);
 const log=await rewardConfigChangeLog(hr,{area:'salary'});
 expect(log.rows.map(r=>[r.itemLabel,r.action,r.actorName]).sort()).toEqual([['CTRO Salary 2026','activated','Fictional CTRO'],['HR Admin Salary 2026','activated','Fictional group HR Admin']]);
 expect((await rewardLibraries(hr,'salary',2026)).map(l=>l.name).sort()).toEqual(['CTRO Salary','HR Admin Salary']);
 // Group-wide items need group-wide authority: the company-scoped HR Admin and an employee are refused, natively too.
 for(const actor of [scoped,staff]){
  await expect(saveRewardLibrary(actor,salaryRaw('Refused Salary',grades))).rejects.toThrow(/not available/);
  await expect(withTenant(actor,tx=>tx.execute(sql`insert into reward_library(tenant_id,kind,name,year,created_by) values(app.current_tenant_id(),'salary','Raw refused',2026,app.current_user_id())`))).rejects.toThrow();
  expect(await withTenant(actor,tx=>tx.execute(sql`select id from reward_library_version`))).toHaveLength(0);
  expect((await withTenant(actor,tx=>tx.execute<{allowed:boolean}>(sql`select app.reward_config_editor(null::uuid) as allowed`)))[0].allowed).toBe(false);
 }
 // One notice per save: the other editors (HR Admin included), never the editor.
 const [event]=await owner.db.execute<{aggregate_id:string}>(sql`select aggregate_id from domain_event where tenant_id=${b.tenantId}::uuid and event_type='rewards-config.changed' and payload->>'itemLabel'='CTRO Salary 2026'`);
 const recipients=(await withTenant(adminCtx(b),tx=>tx.execute<{id:string}>(sql`select app.reward_config_change_recipients(${event.aggregate_id}::uuid) as id`))).map(r=>r.id);
 expect(recipients).toContain(await jobOf(hr.userId));expect(recipients).not.toContain(await jobOf(c.userId));
 expect(recipients).not.toContain(await jobOf(scoped.userId));expect(recipients).not.toContain(await jobOf(staff.userId));
},90_000);

it('lets CTRO and a company-scoped HR Admin make company PAT active within their companies only',async()=>{
 const c=await ctro(b),scoped=await hrAdmin(b,b.companyId,'Fictional company HR Admin'),staff=await employee(b,'Fictional employee');
 const [other]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Other PAT Company'}).returning();
 await saveRewardPatBatch(scoped,{year:2026,mode:'active',reason:'Company HR Admin enters the company PAT',rows:[{companyId:b.companyId,expectedRevision:0,inputs:pat}]});
 await saveRewardPatBatch(c,{year:2026,mode:'active',reason:'CTRO enters the other company PAT',rows:[{companyId:other.id,expectedRevision:0,inputs:{...pat,actualCents:800_000}}]});
 const rows=await owner.db.execute<{company_id:string;state:string;created_by:string;confirmed_by:string}>(sql`select company_id,state,created_by,confirmed_by from reward_pat_version where tenant_id=${b.tenantId}::uuid order by created_at`);
 expect(rows).toEqual([{company_id:b.companyId,state:'confirmed',created_by:scoped.userId,confirmed_by:scoped.userId},{company_id:other.id,state:'confirmed',created_by:c.userId,confirmed_by:c.userId}]);
 // The company-scoped HR Admin sees and edits only their company.
 expect((await rewardPatInputs(scoped,2026)).map(r=>r.company.id)).toEqual([b.companyId]);
 expect((await rewardPatInputs(c,2026)).map(r=>r.company.id).sort()).toEqual([b.companyId,other.id].sort());
 await expect(saveRewardPatBatch(scoped,{year:2026,mode:'draft',reason:'Outside my companies',rows:[{companyId:other.id,expectedRevision:1,inputs:pat}]})).rejects.toThrow(/not available/);
 expect(await withTenant(scoped,tx=>tx.execute(sql`select id from reward_pat_version where company_id=${other.id}::uuid`))).toHaveLength(0);
 await expect(withTenant(scoped,tx=>tx.execute(sql`insert into reward_pat_version(tenant_id,company_id,year,revision,inputs,created_by,created_by_person_id,reason) values(app.current_tenant_id(),${other.id}::uuid,2027,1,${JSON.stringify(pat)}::jsonb,app.current_user_id(),${scoped.personId}::uuid,'Raw PAT outside scope')`))).rejects.toThrow();
 await expect(rewardPatInputs(staff,2026)).rejects.toThrow(/not available/);
 await expect(saveRewardPatBatch(staff,{year:2026,mode:'draft',reason:'Employee tries to edit PAT',rows:[{companyId:b.companyId,expectedRevision:1,inputs:pat}]})).rejects.toThrow(/not available/);
 // The change log rows carry the company and the editor; the company HR Admin reads only their company's rows.
 const log=await rewardConfigChangeLog(scoped,{area:'pat'});
 expect(log.rows.map(r=>[r.action,r.actorName])).toEqual([['activated','Fictional company HR Admin']]);
},90_000);

it('keeps another tenant out: its editors cannot read, write or log this tenant\'s configuration',async()=>{
 const here=await hrAdmin(b,null,'Fictional HR Admin here'),grades=await setupGrades(here);
 await saveRewardLibrary(here,salaryRaw('Tenant one Salary',grades));
 await saveRewardPatBatch(here,{year:2026,mode:'active',reason:'Tenant one PAT figures',rows:[{companyId:b.companyId,expectedRevision:0,inputs:pat}]});
 const b2=await seedBase();await setModule(b2.tenantId,'rewards','active');
 const there=await hrAdmin(b2,null,'Fictional HR Admin there');
 expect(await withTenant(there,tx=>tx.execute(sql`select id from reward_library_version`))).toHaveLength(0);
 expect(await withTenant(there,tx=>tx.execute(sql`select id from reward_pat_version`))).toHaveLength(0);
 expect(await withTenant(there,tx=>tx.execute(sql`select id from reward_config_change`))).toHaveLength(0);
 expect((await withTenant(there,tx=>tx.execute<{allowed:boolean}>(sql`select app.reward_config_editor(${b.companyId}::uuid) as allowed`)))[0].allowed).toBe(false);
 await expect(saveRewardPatBatch(there,{year:2026,mode:'draft',reason:'Cross-tenant PAT attempt',rows:[{companyId:b.companyId,expectedRevision:1,inputs:pat}]})).rejects.toThrow();
 expect((await owner.db.execute<{n:number}>(sql`select count(*)::int as n from reward_pat_version where company_id=${b.companyId}::uuid`))[0].n).toBe(1);
},90_000);

/** Migration 5600: the Role permissions grid still narrows CTRO and HR Admin on these pages. A saved level never
 * exceeds the default; View only reads but does not write, and "—" removes the page, natively too. */
const narrow=(base:Base,role:string,capability:string,level:'view'|'none')=>owner.db.execute(sql`insert into reward_role_permission(tenant_id,role,capability,allowed,level,changed_by,reason)
 values(${base.tenantId}::uuid,${role},${capability},${level!=='none'},${level},${base.adminUserId}::uuid,'Fictional narrowing of a configuration page')`);
const libraryKinds=(ctx:SessionContext)=>withTenant(ctx,tx=>tx.execute<{kind:string}>(sql`select distinct kind from reward_library order by kind`)).then(rows=>rows.map(r=>r.kind));
const rawLibrary=(ctx:SessionContext,kind:'salary'|'bonus')=>withTenant(ctx,tx=>tx.execute(sql`insert into reward_library(tenant_id,kind,name,year,created_by) values(app.current_tenant_id(),${kind},${'Raw '+kind+' '+randomUUID()},2026,app.current_user_id())`));

it('narrows CTRO and HR Admin through the Role permissions grid: View only reads without writing, and none removes the page',async()=>{
 const c=await ctro(b),hr=await hrAdmin(b,null,'Fictional group HR Admin'),scoped=await hrAdmin(b,b.companyId,'Fictional company HR Admin');
 const grades=await setupGrades(c);
 for(const kind of ['salary','bonus'])await owner.db.execute(sql`insert into reward_library(tenant_id,kind,name,year,created_by) values(${b.tenantId}::uuid,${kind},${'Fictional '+kind},2026,${b.adminUserId}::uuid)`);
 // At the default (Full) both edit both libraries and PAT.
 for(const actor of [c,hr]){
  expect(await libraryKinds(actor)).toEqual(['bonus','salary']);
  expect((await rewardLibraryPageAccess(actor,'salary')).canManage).toBe(true);expect((await rewardLibraryPageAccess(actor,'bonus')).canManage).toBe(true);
  expect(await rewardNavigation(actor)).toEqual(expect.arrayContaining(['/admin/rewards/salary-structures','/admin/rewards/bonus-matrices','/admin/rewards/pat-inputs']));
 }
 await rawLibrary(c,'salary');await rawLibrary(hr,'bonus');
 // A company-scoped HR Admin holds Full on the row but still has no group-wide library page.
 const scopedPage=await withTenant(scoped,tx=>tx.execute<{view:boolean;manage:boolean}>(sql`select app.reward_config_page_allowed(null,'salary.view','library_view') as view,app.reward_config_page_allowed(null,'salary.view','manage') as manage`));
 expect(scopedPage[0]).toEqual({view:false,manage:false});await expect(rewardLibraryPageAccess(scoped,'salary')).rejects.toThrow(/not available/);
 expect(await libraryKinds(scoped)).toEqual([]);await expect(rawLibrary(scoped,'salary')).rejects.toThrow();

 await narrow(b,'ctro','salary.view','view');await narrow(b,'ctro','pat.manage','none');
 await narrow(b,'hr_admin','salary.view','none');await narrow(b,'hr_admin','bonus.view','view');
 // CTRO, Salary Structures at View only: reads, cannot save through the service or around it.
 expect(await libraryKinds(c)).toEqual(['bonus','salary']);
 expect(await rewardLibraryPageAccess(c,'salary')).toEqual({canManage:false});
 await expect(saveRewardLibrary(c,salaryRaw('Refused CTRO Salary',grades))).rejects.toThrow(/not available/);
 await expect(rawLibrary(c,'salary')).rejects.toThrow();
 await rawLibrary(c,'bonus');
 // CTRO, PAT Inputs at none: no page, no save, no raw write.
 await expect(rewardPatInputs(c,2026)).rejects.toThrow(/not available/);
 await expect(saveRewardPatBatch(c,{year:2026,mode:'draft',reason:'CTRO after PAT narrowing',rows:[{companyId:b.companyId,expectedRevision:0,inputs:pat}]})).rejects.toThrow(/not available/);
 await expect(withTenant(c,tx=>tx.execute(sql`insert into reward_pat_version(tenant_id,company_id,year,revision,inputs,created_by,created_by_person_id,reason) values(app.current_tenant_id(),${b.companyId}::uuid,2026,1,${JSON.stringify(pat)}::jsonb,app.current_user_id(),${c.personId}::uuid,'Raw PAT after narrowing')`))).rejects.toThrow();
 const ctroNav=await rewardNavigation(c);expect(ctroNav).toContain('/admin/rewards/salary-structures');expect(ctroNav).not.toContain('/admin/rewards/pat-inputs');
 // HR Admin, Salary Structures at none and Bonus Matrices at View only.
 expect(await libraryKinds(hr)).toEqual(['bonus']);
 await expect(rewardLibraryPageAccess(hr,'salary')).rejects.toThrow(/not available/);
 expect(await rewardLibraryPageAccess(hr,'bonus')).toEqual({canManage:false});
 await expect(saveRewardLibrary(hr,salaryRaw('Refused HR Admin Salary',grades))).rejects.toThrow(/not available/);
 await expect(rawLibrary(hr,'bonus')).rejects.toThrow();await expect(rawLibrary(hr,'salary')).rejects.toThrow();
 const hrNav=await rewardNavigation(hr);expect(hrNav).not.toContain('/admin/rewards/salary-structures');expect(hrNav).toContain('/admin/rewards/bonus-matrices');expect(hrNav).toContain('/admin/rewards/pat-inputs');
 // HR Admin keeps PAT at Full, within their companies.
 await saveRewardPatBatch(hr,{year:2026,mode:'active',reason:'HR Admin still enters company PAT',rows:[{companyId:b.companyId,expectedRevision:0,inputs:pat}]});
 expect((await owner.db.execute<{n:number}>(sql`select count(*)::int as n from reward_pat_version where company_id=${b.companyId}::uuid and state='confirmed'`))[0].n).toBe(1);
 // The level the row-security policies read: the saved narrowing for CTRO, the default for HR Admin.
 expect((await withTenant(c,tx=>tx.execute<{level:string}>(sql`select app.reward_actor_page_level('salary.view') as level`)))[0].level).toBe('view');
 expect((await withTenant(hr,tx=>tx.execute<{level:string}>(sql`select app.reward_actor_page_level('pat.manage') as level`)))[0].level).toBe('full');
},120_000);

/** Migration 5600 (restricted-owner audit): on an installation the owner-owned definers run as the restricted
 * ai_hr_owner, which may execute only what it owns, what is granted to PUBLIC or to it, and the DBA prerequisite's
 * app.reward_setup_allowed. CI builds this database as a superuser, so a call into a purpose-owned function fails
 * only on a real installation (5580's review creator called two of them). Every app.* function a board-block owner
 * definer names must be executable by ai_hr_owner. */
it('lets ai_hr_owner execute every function the board owner definers call',async()=>{
 const prerequisite=new Set(['app.reward_setup_allowed(uuid,text)']);
 const definers=await owner.db.execute<{fn:string;src:string}>(sql`select p.oid::regprocedure::text as fn,p.prosrc as src from pg_proc p
  where p.pronamespace='app'::regnamespace and p.prosecdef and p.proowner=(select proowner from pg_proc where oid='app.reward_config_editor(uuid)'::regprocedure)
   and (p.proname like 'reward\\_config\\_%' or p.proname like 'reward\\_limit\\_%' or p.proname like 'reward\\_offcycle\\_%'
    or p.proname in('reward_actor_holds_role','reward_access_self_change_guard','reward_unit_limit_version'))
  union all select p.oid::regprocedure::text,p.prosrc from pg_proc p where p.oid='app.reward_config_snapshot_pay_change_kind(uuid)'::regprocedure`);
 expect(definers.map(d=>d.fn)).toEqual(expect.arrayContaining(['app.reward_config_create_planned_unit(uuid,uuid,uuid)','app.reward_config_architecture_for_source(uuid,uuid,uuid,date)','app.reward_config_editor(uuid)']));
 const refused:string[]=[];
 for(const d of definers){
  const names=[...new Set([...d.src.matchAll(/app\.([a-z_][a-z0-9_]*)\(/g)].map(m=>m[1]))];
  if(!names.length)continue;
  // The migration owner owns its own functions (here the superuser that built the database, on an installation
  // ai_hr_owner); anything else needs an EXECUTE grant ai_hr_owner holds.
  const callees=await owner.db.execute<{fn:string;ok:boolean}>(sql`select p.oid::regprocedure::text as fn,
    p.proowner=(select proowner from pg_proc where oid='app.reward_config_editor(uuid)'::regprocedure) or has_function_privilege('ai_hr_owner',p.oid,'EXECUTE') as ok
   from pg_proc p where p.pronamespace='app'::regnamespace and p.proname=any(${names}::text[])`);
  for(const c of callees)if(!c.ok&&!prerequisite.has(c.fn))refused.push(`${d.fn} -> ${c.fn}`);
 }
 expect(refused).toEqual([]);
 // The purpose-owned originals stay installed and untouched.
 const purpose=await owner.db.execute<{fn:string;owner:string}>(sql`select p.oid::regprocedure::text as fn,pg_get_userbyid(p.proowner)::text as owner from pg_proc p
  where p.oid in('app.reward_architecture_for_source(uuid,uuid,uuid,date)'::regprocedure,'app.reward_snapshot_pay_change_kind(uuid)'::regprocedure) order by 1`);
 expect(purpose).toEqual([{fn:'app.reward_architecture_for_source(uuid,uuid,uuid,date)',owner:'ai_hr_reward_setup_reader'},{fn:'app.reward_snapshot_pay_change_kind(uuid)',owner:'ai_hr_reward_setup_reader'}]);
});
