/** Board 60f1fdcd / 2103041d: Rewards configuration is saved directly by one accountable editor, every command writes
 * one change-log row and one co-administrator notice in its own transaction, and nobody changes their own access or
 * the switches for a role they hold. Fictional tenant data only. */
import {randomUUID} from 'node:crypto';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {sql} from 'drizzle-orm';
import {adminCtx,createAppUser,setModule,owner,migrateTestDb,resetDb,seedBase,closeAll,type Base} from './harness';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {hireEmployee} from '../core/org';
import {saveRewardLibrary,restoreRewardLibraryVersion,activateRewardLibrary,submitRewardLibrary} from '../packs/rewards/libraries';
import {saveRewardPatBatch,previewRewardPatBatch,rewardPatInputs} from '../packs/rewards/pat-inputs';
import {changeRewardPermission} from '../packs/rewards/access-policy';
import {rewardConfigChangeLog,rewardConfigChangeExport} from '../packs/rewards/config-change';
import {setupGrades} from './rewards-setup-fixture';

let b:Base;
beforeAll(migrateTestDb);afterAll(closeAll);
beforeEach(async()=>{await resetDb();b=await seedBase();await setModule(b.tenantId,'rewards','active');});

/** A real, employed Group Rewards configuration editor with a group-level setup grant. */
async function editor(name:string):Promise<SessionContext&{personId:string}>{
 const hired=await hireEmployee(adminCtx(b),{person:{fullName:name,primaryEmail:randomUUID()+'@direct-config.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',employeeCode:'DC-'+randomUUID().slice(0,6),hiredOn:'2024-01-01'});
 const userId=await createAppUser(b.tenantId,hired.personId,'employee');
 await owner.db.execute(sql`insert into reward_setup_grant(tenant_id,user_id,role,valid_from,created_by,reason) values(${b.tenantId}::uuid,${userId}::uuid,'gr','2000-01-01',${b.adminUserId}::uuid,'Fictional direct configuration editor')`);
 return{...adminCtx(b),userId,personId:hired.personId,roles:['employee'],grants:[{role:'employee',companyId:null}]};
}
const salaryData=(grades:{gradeId:string;grade:string}[],scale=1)=>({kind:'salary' as const,rows:grades.map(g=>({...g,minimumCents:g.grade==='23'?null:10000*scale,midpointCents:g.grade==='23'?null:20000*scale,maximumCents:g.grade==='23'?null:30000*scale}))});
const changes=(where:ReturnType<typeof sql>)=>owner.db.execute<{area:string;action:string;actor_id:string|null;high_impact:boolean;changed_count:number;reason:string;restored_from:string|null;summary:{lines:{key:string;before:string|null;after:string|null}[]}}>(sql`select area,action,actor_id,high_impact,changed_count,reason,restored_from,summary from reward_config_change where tenant_id=${b.tenantId}::uuid and ${where} order by at,id`);

it('lets one editor save and make a salary structure active, logs exactly one row per command and notifies the other editor only',async()=>{
 const maker=await editor('Fictional Mei Ong'),colleague=await editor('Fictional Rewards colleague'),grades=await setupGrades(maker);
 const id=await saveRewardLibrary(maker,{libraryId:null,versionId:null,expectedLock:0,name:'Direct Salary',year:2026,tags:[],groupDefault:false,previousLibraryId:null,data:salaryData(grades),reason:'Board 60f1fdcd direct activation',mode:'active'});
 const [version]=await owner.db.execute<{state:string;confirmed_by:string;confirmed_by_person_id:string;library_id:string}>(sql`select state,confirmed_by,confirmed_by_person_id,library_id from reward_library_version where id=${id}::uuid`);
 expect(version).toMatchObject({state:'confirmed',confirmed_by:maker.userId,confirmed_by_person_id:maker.personId});
 const rows=await changes(sql`item_id=${version.library_id}::uuid`);
 expect(rows.map(r=>[r.area,r.action,r.actor_id,r.high_impact])).toEqual([['salary','activated',maker.userId,false]]);
 expect(rows[0].changed_count).toBe(36);
 expect(rows[0].summary.lines.find(line=>line.key==='12:Midpoint')).toEqual({key:'12:Midpoint',label:'JG 12 Midpoint',before:null,after:'200.00'});
 // One notice per save, to the colleague and never to the editor.
 const [event]=await owner.db.execute<{aggregate_id:string;payload:Record<string,unknown>}>(sql`select aggregate_id,payload from domain_event where tenant_id=${b.tenantId}::uuid and event_type='rewards-config.changed'`);
 expect(event.payload).toMatchObject({area:'salary',itemLabel:'Direct Salary 2026',changedCount:36,actorName:'Fictional Mei Ong'});
 expect(JSON.stringify(event.payload)).not.toMatch(/20000|200\.00/);
 await owner.db.execute(sql`insert into reward_group_role_grant(tenant_id,user_id,role,active,revision) values(${b.tenantId}::uuid,${colleague.userId}::uuid,'gr',true,1),(${b.tenantId}::uuid,${maker.userId}::uuid,'gr',true,1)`);
 const recipients=await withTenant(adminCtx(b),tx=>tx.execute<{id:string}>(sql`select app.reward_config_change_recipients(${event.aggregate_id}::uuid) as id`));
 const [colleagueJob]=await owner.db.execute<{id:string}>(sql`select e.id from employment e join app_user u on u.person_id=e.person_id where u.id=${colleague.userId}::uuid`);
 const [makerJob]=await owner.db.execute<{id:string}>(sql`select e.id from employment e join app_user u on u.person_id=e.person_id where u.id=${maker.userId}::uuid`);
 expect(recipients.map(r=>r.id)).toContain(colleagueJob.id);expect(recipients.map(r=>r.id)).not.toContain(makerJob.id);
 // The legacy two-step path is also single-person now.
 const second=await saveRewardLibrary(maker,{libraryId:version.library_id,versionId:null,expectedLock:0,name:'Direct Salary',year:2026,tags:[],groupDefault:false,previousLibraryId:null,data:salaryData(grades,2),reason:'Second version for the legacy path'});
 await submitRewardLibrary(maker,second,1);await activateRewardLibrary(maker,second,2,'Made the submitted draft active myself');
 expect((await owner.db.execute<{state:string}>(sql`select state from reward_library_version where id=${second}::uuid`))[0].state).toBe('confirmed');
 expect((await changes(sql`item_id=${version.library_id}::uuid`)).map(r=>r.action)).toEqual(['activated','saved-draft','activated']);
},60_000);

it('restores an earlier library version as a new draft and leaves the old version untouched',async()=>{
 const maker=await editor('Fictional restorer'),grades=await setupGrades(maker);
 const first=await saveRewardLibrary(maker,{libraryId:null,versionId:null,expectedLock:0,name:'Restore Salary',year:2026,tags:[],groupDefault:false,previousLibraryId:null,data:salaryData(grades),reason:'First active version',mode:'active'});
 const [{library_id:libraryId,data:firstData}]=await owner.db.execute<{library_id:string;data:unknown}>(sql`select library_id,data from reward_library_version where id=${first}::uuid`);
 await saveRewardLibrary(maker,{libraryId,versionId:null,expectedLock:0,name:'Restore Salary',year:2026,tags:[],groupDefault:false,previousLibraryId:null,data:salaryData(grades,3),reason:'Second active version',mode:'active'});
 const restored=await restoreRewardLibraryVersion(maker,{versionId:first,mode:'draft',reason:'Restore the first version values'});
 const versions=await owner.db.execute<{id:string;revision:number;state:string;data:unknown}>(sql`select id,revision,state,data from reward_library_version where library_id=${libraryId}::uuid order by revision`);
 expect(versions.map(v=>[v.revision,v.state])).toEqual([[1,'confirmed'],[2,'confirmed'],[3,'draft']]);
 expect(versions[2].id).toBe(restored);expect(versions[2].data).toEqual(firstData);expect(versions[0].data).toEqual(firstData);
 const log=await changes(sql`item_id=${libraryId}::uuid and action='restored'`);
 expect(log).toHaveLength(1);expect(log[0].restored_from).toBe(first);
},60_000);

it('saves a PAT batch as a draft, makes it active by the same editor, and rolls the whole batch back on a stale row',async()=>{
 const maker=await editor('Fictional PAT editor');
 const [second]=await owner.db.insert(schema.company).values({tenantId:b.tenantId,legalName:'Fictional Second PAT Company'}).returning();
 const year=2026,inputs={targetCents:1_000_000,forecastCents:900_000,actualCents:null,targetMonthsBp:20000};
 const draft=await saveRewardPatBatch(maker,{year,mode:'draft',reason:'Initial PAT figures for two companies',rows:[{companyId:b.companyId,expectedRevision:0,inputs},{companyId:second.id,expectedRevision:0,inputs}]});
 expect(draft.versionIds).toHaveLength(2);
 const states=await owner.db.execute<{state:string;n:number}>(sql`select state,count(*)::int as n from reward_pat_version where tenant_id=${b.tenantId}::uuid group by state`);
 expect(states).toEqual([{state:'pending',n:2}]);
 // The open draft is edited in place by the same editor and then made active: no second person.
 const next={...inputs,actualCents:1_100_000};
 const preview=await previewRewardPatBatch(maker,{year,mode:'active',reason:'Preview only, not saved.',rows:[{companyId:b.companyId,expectedRevision:1,inputs:next}]});
 expect(preview.summary.highImpact).toEqual([]);
 expect(preview.summary.lines.map(l=>[l.key.split(':').pop(),l.before,l.after])).toEqual([['actualCents',null,'11000.00']]);
 await saveRewardPatBatch(maker,{year,mode:'active',reason:'Actual PAT confirmed for the year',summaryDigest:preview.digest,rows:[{companyId:b.companyId,expectedRevision:1,inputs:next}]});
 const [active]=await owner.db.execute<{revision:number;state:string;confirmed_by:string;created_by:string;inputs:typeof next}>(sql`select revision,state,confirmed_by,created_by,inputs from reward_pat_version where company_id=${b.companyId}::uuid and year=${year}`);
 expect(active).toEqual({revision:1,state:'confirmed',confirmed_by:maker.userId,created_by:maker.userId,inputs:next});
 // A stale second row: nothing in the batch is saved and no change-log row is written.
 const before=await changes(sql`area='pat'`);
 await expect(saveRewardPatBatch(maker,{year,mode:'active',reason:'Batch with one stale company row',rows:[{companyId:b.companyId,expectedRevision:1,inputs:{...next,targetMonthsBp:30000}},{companyId:second.id,expectedRevision:7,inputs}]})).rejects.toThrow(/changed in another session/);
 expect(await changes(sql`area='pat'`)).toHaveLength(before.length);
 expect((await owner.db.execute<{n:number}>(sql`select count(*)::int as n from reward_pat_version where company_id=${b.companyId}::uuid`))[0].n).toBe(1);
 expect(before.map(r=>r.action)).toEqual(['saved-draft','activated']);
 const grid=await rewardPatInputs(maker,year);
 expect(grid.find(r=>r.company.id===b.companyId)?.current?.inputs).toEqual(next);
 expect(grid.find(r=>r.company.id===second.id)?.pending?.inputs).toEqual(inputs);
},60_000);

it('lets the PAT maker activate through raw SQL as the application role (the 2203 maker-checker CHECK is gone)',async()=>{
 const maker=await editor('Fictional raw PAT editor');
 const {versionIds:[id]}=await saveRewardPatBatch(maker,{year:2027,mode:'draft',reason:'Raw SQL single-person activation',rows:[{companyId:b.companyId,expectedRevision:0,inputs:{targetCents:500,forecastCents:null,actualCents:400,targetMonthsBp:10000}}]});
 await withTenant(maker,tx=>tx.execute(sql`update reward_pat_version set state='confirmed',confirmed_by=app.current_user_id(),confirmed_at=now() where id=${id}::uuid`));
 const [row]=await owner.db.execute<{state:string;confirmed_by_person_id:string}>(sql`select state,confirmed_by_person_id from reward_pat_version where id=${id}::uuid`);
 expect(row).toEqual({state:'confirmed',confirmed_by_person_id:maker.personId});
 // Active figures stay immutable.
 await expect(withTenant(maker,tx=>tx.execute(sql`update reward_pat_version set reason='Rewrite active figures' where id=${id}::uuid returning id`))).resolves.toHaveLength(0);
},60_000);

it('refuses the switches for a role the editor holds and logs a permitted role change',async()=>{
 const maker=await editor('Fictional permissions editor');
 await expect(changeRewardPermission(maker,{role:'gr',capability:'figures.edit',allowed:false,reason:'Try to narrow my own role'})).rejects.toThrow(/role you hold/);
 await expect(withTenant(maker,tx=>tx.execute(sql`insert into reward_role_permission(tenant_id,role,capability,allowed,changed_by,reason) values(app.current_tenant_id(),'gr','figures.edit',false,app.current_user_id(),'Raw own-role write attempt')`))).rejects.toThrow();
 await changeRewardPermission(maker,{role:'bu',capability:'figures.edit',allowed:false,reason:'BU CEO figures edit narrowed'});
 const log=await changes(sql`area='role_permission'`);
 expect(log.map(r=>[r.action,r.actor_id,r.summary.lines[0]?.before,r.summary.lines[0]?.after])).toEqual([['changed',maker.userId,'Default','Off']]);
},60_000);

it('refuses an immediate access change that adds the actor and allows removing their own seat',async()=>{
 const maker=await editor('Fictional access editor');
 const alias=await createAppUser(b.tenantId,maker.personId,'employee');
 const insert=(after:unknown,before:unknown)=>owner.db.execute<{id:string}>(sql`insert into reward_access_request(tenant_id,changes,unit_revisions,before_members,people_fingerprints,requested_by) values(${b.tenantId}::uuid,${JSON.stringify([{unitId:randomUUID(),revision:1,before,after}])}::jsonb,'{}'::jsonb,'{}'::jsonb,'{}'::jsonb,${maker.userId}::uuid) returning id`);
 const apply=(id:string)=>owner.db.execute(sql`update reward_access_request set status='applied_no_second_approval',decided_at=now() where id=${id}::uuid`);
 const [self]=await insert({userId:maker.userId,role:'gr'},null);
 await expect(apply(self.id)).rejects.toThrow(/own Rewards access/);
 const [sameperson]=await insert({userId:alias,role:'bu'},null);
 await expect(apply(sameperson.id)).rejects.toThrow(/own Rewards access/);
 const [lengthen]=await insert({userId:maker.userId,role:'gr',validTo:'2030-12-31'},{userId:maker.userId,role:'gr',validTo:'2026-12-31'});
 await expect(apply(lengthen.id)).rejects.toThrow(/own Rewards access/);
 const [removal]=await insert(null,{userId:maker.userId,role:'gr'});
 await apply(removal.id);
 const [other]=await insert({userId:b.adminUserId,role:'bu'},null);
 await apply(other.id);
 expect((await owner.db.execute<{status:string}>(sql`select status from reward_access_request where id in(${removal.id}::uuid,${other.id}::uuid)`)).map(r=>r.status)).toEqual(['applied_no_second_approval','applied_no_second_approval']);
},60_000);

it('shows the change log only to configuration editors of the same tenant, page by page, and exports the same rows',async()=>{
 const maker=await editor('Fictional log editor'),grades=await setupGrades(maker);
 await saveRewardLibrary(maker,{libraryId:null,versionId:null,expectedLock:0,name:'=HYPERLINK("x")',year:2026,tags:[],groupDefault:false,previousLibraryId:null,data:salaryData(grades),reason:'Formula-looking label must stay text'});
 const log=await rewardConfigChangeLog(maker,{});
 expect(log.rows.map(r=>[r.area,r.action,r.itemLabel,r.actorName])).toEqual([['salary','saved-draft','=HYPERLINK("x") 2026','Fictional log editor']]);
 expect((await rewardConfigChangeLog(maker,{area:'pat'})).rows).toEqual([]);
 expect((await rewardConfigChangeExport(maker,{})).rows.map(r=>r.id)).toEqual(log.rows.map(r=>r.id));
 // An employee without Rewards configuration authority is refused; the row is not readable through raw SQL either.
 const outsiderHire=await hireEmployee(adminCtx(b),{person:{fullName:'Fictional outsider',primaryEmail:randomUUID()+'@direct-config.test'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',employeeCode:'DC-OUT',hiredOn:'2024-01-01'});
 const outsider={...adminCtx(b),userId:await createAppUser(b.tenantId,outsiderHire.personId,'employee'),personId:outsiderHire.personId,roles:['employee'],grants:[{role:'employee' as const,companyId:null}]};
 await expect(rewardConfigChangeLog(outsider,{})).rejects.toThrow(/not available/);
 expect(await withTenant(outsider,tx=>tx.execute(sql`select id from reward_config_change`))).toHaveLength(0);
 // The table is append-only for the application role.
 await expect(withTenant(maker,tx=>tx.execute(sql`update reward_config_change set reason='Rewritten history entry'`))).rejects.toThrow();
 await expect(withTenant(maker,tx=>tx.execute(sql`delete from reward_config_change`))).rejects.toThrow();
},60_000);
