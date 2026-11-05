import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {appUser,person,roleAssignment,company,jobGrade,employment} from '../db/schema';
import {type SessionContext,withTenant} from '../db/client';
import {todayInKualaLumpur} from '../lib/hr-date';
import {architectureWorkspace,assignArchitectureSeat,proposeArchitectureCatalogue,decideArchitectureProposal,scanArchitecture,proposeOutlierResolution} from '../packs/job-architecture/service';
let b:Base,checker:SessionContext;
beforeAll(async()=>{await migrateTestDb();});
beforeEach(async()=>{await resetDb();b=await seedBase();await owner.db.execute(sql`update access_capability set supported=false,bindings='[]'::jsonb where id in ('workforce.view','workforce.maintain')`);const[p]=await owner.db.insert(person).values({tenantId:b.tenantId,fullName:'Independent architecture checker',primaryEmail:randomUUID()+'@architecture.test'}).returning();const[u]=await owner.db.insert(appUser).values({tenantId:b.tenantId,personId:p.id,workosUserId:randomUUID()}).returning();await owner.db.insert(roleAssignment).values({tenantId:b.tenantId,appUserId:u.id,role:'hr_admin',companyId:null});checker={...adminCtx(b),userId:u.id};await assignArchitectureSeat(adminCtx(b),{userId:b.adminUserId,companyId:null,role:'group_rewards',validFrom:todayInKualaLumpur(),validTo:null});await assignArchitectureSeat(adminCtx(b),{userId:u.id,companyId:null,role:'group_rewards',validFrom:todayInKualaLumpur(),validTo:null});});
afterAll(closeAll);
const empty={nodes:[],ladder:[]};
it('requires an independent explicitly authorized checker and preserves immutable approved versions',async()=>{
 const id=await proposeArchitectureCatalogue(adminCtx(b),{catalogue:empty,baseRevision:0,reason:'Create the first reviewed catalogue'});
 await expect(decideArchitectureProposal(adminCtx(b),{id,approve:true})).rejects.toThrow(/access|different|no longer/);
 await decideArchitectureProposal(checker,{id,approve:true});const w=await architectureWorkspace(adminCtx(b));expect(w.catalogue.revision).toBe(1);expect(w.catalogue.catalogue).toEqual(empty);
 expect(await withTenant(checker,tx=>tx.execute(sql`update job_architecture_catalogue_revision set catalogue='{}'::jsonb where tenant_id=${b.tenantId}::uuid returning revision`))).toHaveLength(0);expect((await architectureWorkspace(checker)).catalogue.catalogue).toEqual(empty);
 await expect(decideArchitectureProposal(checker,{id,approve:true})).rejects.toThrow(/no longer/);
 const[e]=await owner.db.execute(sql`select count(*)::int as n from domain_event where tenant_id=${b.tenantId}::uuid and aggregate_type='job-architecture' and event_type='job-architecture.proposal.approved'`);expect(e.n).toBe(1);
});
it('rejects stale catalogue approvals without consuming the losing proposal',async()=>{
 const a=await proposeArchitectureCatalogue(adminCtx(b),{catalogue:empty,baseRevision:0,reason:'First draft of shared classification'}),c=await proposeArchitectureCatalogue(adminCtx(b),{catalogue:empty,baseRevision:0,reason:'Competing classification proposal'});
 await decideArchitectureProposal(checker,{id:a,approve:true});await expect(decideArchitectureProposal(checker,{id:c,approve:true})).rejects.toThrow(/newer/);
 const[r]=await owner.db.execute(sql`select status from job_architecture_proposal where id=${c}::uuid`);expect(r.status).toBe('pending');
});
it('keeps another tenant out of proposals, catalogue and seats, even with an administrative session',async()=>{
 const id=await proposeArchitectureCatalogue(adminCtx(b),{catalogue:empty,baseRevision:0,reason:'Tenant-specific architecture proposal'});const other=await seedBase();
 await expect(decideArchitectureProposal(adminCtx(other),{id,approve:true})).rejects.toThrow(/no longer/);
 const rows=await withTenant(adminCtx(other),tx=>tx.execute(sql`select id from job_architecture_proposal where id=${id}::uuid`));expect(rows).toHaveLength(0);
 await expect(assignArchitectureSeat(adminCtx(b),{userId:adminCtx(other).userId,companyId:null,role:'org_design',validFrom:todayInKualaLumpur(),validTo:null})).rejects.toThrow(/tenant/);
});
it('runs repeatable scans without duplicate outlier records or employee grade writes',async()=>{
 const before=await owner.db.execute(sql`select id,grade_id from employment where tenant_id=${b.tenantId}::uuid order by id`);
 const first=await scanArchitecture(adminCtx(b)),second=await scanArchitecture(adminCtx(b));expect(first).toBeGreaterThan(0);expect(second).toBe(first);
 const[count]=await owner.db.execute(sql`select count(*)::int as n from job_architecture_outlier where tenant_id=${b.tenantId}::uuid`);expect(count.n).toBe(first);
 expect(await owner.db.execute(sql`select id,grade_id from employment where tenant_id=${b.tenantId}::uuid order by id`)).toEqual(before);
});
it('checks the seat company and end date against the tenant and refuses expired checker authority',async()=>{
 await owner.db.execute(sql`update job_architecture_seat set valid_from='2020-01-01',valid_to='2020-01-02' where tenant_id=${b.tenantId}::uuid and user_id=${checker.userId}::uuid`);
 const id=await proposeArchitectureCatalogue(adminCtx(b),{catalogue:empty,baseRevision:0,reason:'Requires a currently eligible checker'});await expect(decideArchitectureProposal(checker,{id,approve:true})).rejects.toThrow(/access|no longer/);
 const [foreign]=await owner.db.insert(company).values({tenantId:(await seedBase()).tenantId,legalName:'Outside architecture tenant'}).returning();await expect(assignArchitectureSeat(adminCtx(b),{userId:checker.userId,companyId:foreign.id,role:'org_design',validFrom:todayInKualaLumpur(),validTo:null})).rejects.toThrow(/tenant|access/);
});

it('guards every employment writer while preserving unchanged historical grades and legacy grades before official publication',async()=>{
 const [p]=await owner.db.insert(person).values({tenantId:b.tenantId,fullName:'Grade guard employee',primaryEmail:randomUUID()+'@grade.test'}).returning();
 const [legacy]=await owner.db.insert(jobGrade).values({tenantId:b.tenantId,code:'CUSTOM',name:'Legacy custom'}).returning();const [future]=await owner.db.insert(jobGrade).values({tenantId:b.tenantId,code:'jg t3',name:'Future inactive'}).returning();
 const [e]=await owner.db.insert(employment).values({tenantId:b.tenantId,companyId:b.companyId,personId:p.id,hiredOn:todayInKualaLumpur(),gradeId:legacy.id}).returning();
 await expect(owner.db.execute(sql`update employment set grade_id=${future.id}::uuid where id=${e.id}::uuid`)).rejects.toMatchObject({cause:expect.objectContaining({message:'Future architecture grades are not in use',code:'23514'})});
 const codes=['H','12','13','14','15','16','17','18','19','20','21','22','23'];const grades=await owner.db.insert(jobGrade).values(codes.map(code=>({tenantId:b.tenantId,code,name:'Active '+code}))).returning();const ladder=grades.map(g=>({gradeId:g.id,code:g.code,name:g.name,complexity:'Scope',authority:'Authority',people:'People',impact:'Impact',qualifications:'Qualifications'}));
 const proposal=await proposeArchitectureCatalogue(adminCtx(b),{catalogue:{nodes:[],ladder},baseRevision:0,reason:'Official complete active grade ladder'});await decideArchitectureProposal(checker,{id:proposal,approve:true});
 await owner.db.execute(sql`update employment set grade_id=grade_id where id=${e.id}::uuid`);
 await owner.db.execute(sql`update employment set grade_id=${grades[0].id}::uuid where id=${e.id}::uuid`);
 await expect(owner.db.execute(sql`update employment set grade_id=${legacy.id}::uuid where id=${e.id}::uuid`)).rejects.toMatchObject({cause:expect.objectContaining({message:'Choose an approved active architecture grade',code:'23514'})});
 await owner.db.execute(sql`update employment set grade_id=null where id=${e.id}::uuid`);
 await expect(proposeArchitectureCatalogue(adminCtx(b),{catalogue:empty,baseRevision:1,reason:'Must not silently remove official ladder'})).rejects.toThrow(/retain/);
});

it('refuses alternate accounts of the same known person and retains the maker person snapshot',async()=>{
 const [p]=await owner.db.insert(person).values({tenantId:b.tenantId,fullName:'Same-person architecture maker',primaryEmail:randomUUID()+'@identity.test'}).returning();await owner.db.execute(sql`update app_user set person_id=${p.id}::uuid where id=${b.adminUserId}::uuid`);
 const [alias]=await owner.db.insert(appUser).values({tenantId:b.tenantId,personId:p.id,workosUserId:randomUUID()}).returning();await owner.db.insert(roleAssignment).values({tenantId:b.tenantId,appUserId:alias.id,role:'hr_admin',companyId:null});await assignArchitectureSeat(adminCtx(b),{userId:alias.id,companyId:null,role:'group_rewards',validFrom:todayInKualaLumpur(),validTo:null});const aliasCtx={...adminCtx(b),userId:alias.id};
 const id=await proposeArchitectureCatalogue(adminCtx(b),{catalogue:empty,baseRevision:0,reason:'Must be checked by another actual person'});await expect(decideArchitectureProposal(aliasCtx,{id,approve:true})).rejects.toThrow(/different person/);
 const [replacement]=await owner.db.insert(person).values({tenantId:b.tenantId,fullName:'New maker link',primaryEmail:randomUUID()+'@identity.test'}).returning();await owner.db.execute(sql`update app_user set person_id=${replacement.id}::uuid where id=${b.adminUserId}::uuid`);await expect(decideArchitectureProposal(aliasCtx,{id,approve:true})).rejects.toThrow(/different person/);await expect(withTenant(aliasCtx,tx=>tx.execute(sql`update job_architecture_proposal set status='approved',checked_by=${alias.id}::uuid,checked_at=now() where id=${id}::uuid`))).rejects.toThrow();
});
it('uses the shared SQL grade normalization and tenant-bounded assignability owner',async()=>{
 for(const code of ['H','12','13','14','15','16','17','18','19','20','21','22','23'])for(const input of [code,'JG'+code,' jg '+code+' ','\tJG\u00a0'+code+'\n']){const [r]=await withTenant(adminCtx(b),tx=>tx.execute<{code:string}>(sql`select app.architecture_grade(${input}) as code`));expect(r.code).toBe(code);}
 for(const input of ['H1','JG\ufeff t4','11','24','prefix13','']){const [r]=await withTenant(adminCtx(b),tx=>tx.execute<{code:string|null}>(sql`select app.architecture_grade(${input}) as code`));expect(r.code).toBeNull();}
 const [g]=await owner.db.insert(jobGrade).values({tenantId:b.tenantId,code:'13',name:'Assignable13'}).returning();const other=await seedBase();const [foreign]=await owner.db.insert(jobGrade).values({tenantId:other.tenantId,code:'13',name:'Other tenant13'}).returning();const [r]=await withTenant(adminCtx(b),tx=>tx.execute<{yes:boolean;foreignGrade:boolean}>(sql`select app.architecture_grade_assignable(${g.id}::uuid) as yes,app.architecture_grade_assignable(${foreign.id}::uuid) as "foreignGrade"`));expect(r).toMatchObject({yes:true,foreignGrade:false});
});

it('does not treat hidden workforce rows as proof that an employee-grade anomaly was fixed',async()=>{
 const id=randomUUID(),fingerprint='employee-grade-authority-test',detail={fingerprint,type:'employee_grade',companyIds:[b.companyId],recordIds:[],migrationOnly:false};await owner.db.execute(sql`insert into job_architecture_outlier(id,tenant_id,fingerprint,company_ids,detail) values(${id}::uuid,${b.tenantId}::uuid,${fingerprint},array[${b.companyId}::uuid],${JSON.stringify(detail)}::jsonb)`);
 const proposal=await proposeOutlierResolution(adminCtx(b),{id,revision:1,reason:'Independent verification must read the actual employee grade'});await owner.db.execute(sql`delete from role_assignment where tenant_id=${b.tenantId}::uuid and app_user_id=${checker.userId}::uuid`);await owner.db.insert(roleAssignment).values({tenantId:b.tenantId,appUserId:checker.userId!,role:'employee',companyId:null});const domainOnly:SessionContext={...checker,roles:['employee'],grants:[{role:'employee',companyId:null}]};await expect(decideArchitectureProposal(domainOnly,{id:proposal,approve:true})).rejects.toThrow(/workforce-authorized/);const [row]=await owner.db.execute(sql`select state from job_architecture_outlier where id=${id}::uuid`);expect(row.state).toBe('new');
});
