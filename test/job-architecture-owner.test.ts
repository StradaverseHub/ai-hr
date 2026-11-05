import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {beforeAll,beforeEach,afterAll,it,expect} from 'vitest';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {appUser,person,roleAssignment,company} from '../db/schema';
import {type SessionContext,withTenant} from '../db/client';
import {todayInKualaLumpur} from '../lib/hr-date';
import {architectureWorkspace,assignArchitectureSeat,proposeArchitectureCatalogue,decideArchitectureProposal,scanArchitecture} from '../packs/job-architecture/service';
let b:Base,checker:SessionContext;
beforeAll(async()=>{await migrateTestDb();});
beforeEach(async()=>{await resetDb();b=await seedBase();await owner.db.execute(sql`update access_capability set supported=false,bindings='[]'::jsonb where id in ('workforce.view','workforce.maintain')`);const[p]=await owner.db.insert(person).values({tenantId:b.tenantId,fullName:'Independent architecture checker',primaryEmail:randomUUID()+'@architecture.test'}).returning();const[u]=await owner.db.insert(appUser).values({tenantId:b.tenantId,personId:p.id,workosUserId:randomUUID()}).returning();await owner.db.insert(roleAssignment).values({tenantId:b.tenantId,appUserId:u.id,role:'hr_admin',companyId:null});checker={...adminCtx(b),userId:u.id};await assignArchitectureSeat(adminCtx(b),{userId:u.id,companyId:null,role:'group_rewards',validFrom:todayInKualaLumpur(),validTo:null});});
afterAll(closeAll);
const empty={nodes:[],ladder:[]};
it('requires an independent explicitly authorized checker and preserves immutable approved versions',async()=>{
 const id=await proposeArchitectureCatalogue(adminCtx(b),{catalogue:empty,baseRevision:0,reason:'Create the first reviewed catalogue'});
 await expect(decideArchitectureProposal(adminCtx(b),{id,approve:true})).rejects.toThrow(/access|different/);
 await decideArchitectureProposal(checker,{id,approve:true});const w=await architectureWorkspace(adminCtx(b));expect(w.catalogue.revision).toBe(1);expect(w.catalogue.catalogue).toEqual(empty);
 await expect(withTenant(checker,tx=>tx.execute(sql`update job_architecture_catalogue_revision set catalogue='{}'::jsonb where tenant_id=${b.tenantId}::uuid`))).rejects.toThrow();
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
 await owner.db.execute(sql`update job_architecture_seat set valid_from='2020-01-01',valid_to='2020-01-02' where tenant_id=${b.tenantId}::uuid`);
 const id=await proposeArchitectureCatalogue(adminCtx(b),{catalogue:empty,baseRevision:0,reason:'Requires a currently eligible checker'});await expect(decideArchitectureProposal(checker,{id,approve:true})).rejects.toThrow(/access/);
 const [foreign]=await owner.db.insert(company).values({tenantId:(await seedBase()).tenantId,legalName:'Outside architecture tenant'}).returning();await expect(assignArchitectureSeat(adminCtx(b),{userId:checker.userId,companyId:foreign.id,role:'org_design',validFrom:todayInKualaLumpur(),validTo:null})).rejects.toThrow(/tenant|access/);
});
