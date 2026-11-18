/** Ordinary prefix upgrade of existing multi-company plans; exact old source and bindings stay unchanged. */
import {randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {sql} from 'drizzle-orm';
import {beforeAll,afterAll,it,expect} from 'vitest';
import {createDb} from '../db/client';
import {adminCtx,setModule,owner,migrateTestDb,resetDb,seedBase,closeAll} from './harness';
import {businessUnit,company} from '../db/schema';
import {createApprovedRewardPlan,setupCompanyStructureFixture} from './rewards-setup-fixture';
beforeAll(migrateTestDb);afterAll(closeAll);
it('backfills every company in an existing shared plan without rewriting its source, choices or history',async()=>{
 await resetDb();const base=await seedBase();await setModule(base.tenantId,'rewards','active');const ctx=adminCtx(base);
 const [second]=await owner.db.insert(company).values({tenantId:base.tenantId,legalName:'Fictional second upgrade employer'}).returning();
 const units=await owner.db.insert(businessUnit).values([{tenantId:base.tenantId,companyId:base.companyId,code:'UP1',name:'Upgrade BU one'},{tenantId:base.tenantId,companyId:second.id,code:'UP2',name:'Upgrade BU two'}]).returning();
 const targets=[{companyId:base.companyId,businessUnitId:units[0].id},{companyId:second.id,businessUnitId:units[1].id}];
 await setupCompanyStructureFixture(ctx,targets,'2026-01-01');
 const original=await createApprovedRewardPlan(ctx,{name:'Fictional retained two-company plan',year:2026,companyId:base.companyId,businessUnitId:units[0].id,snapshotDate:'2026-01-01'},undefined,targets);
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8')) as {entries:{tag:string;when:number;idx:number}[]};
 const boundary=journal.entries.findIndex(e=>e.tag==='6100_rewards_review_plans');expect(boundary).toBeGreaterThan(0);
 const directory=mkdtempSync(join(tmpdir(),'aihr-review-plan-upgrade-')),dbName='ai_hr_review_plan_upgrade_'+randomUUID().replaceAll('-',''),url=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
 expect(['127.0.0.1','localhost']).toContain(url.hostname);url.pathname='/postgres';const admin=postgres(url.toString(),{max:1,onnotice:()=>{}});url.pathname='/'+dbName;const target=createDb(url.toString(),{max:1});let created=false;
 const retainedTables=['reward_policy_group','reward_policy_group_version','reward_policy_group_target','reward_plan_setup','reward_plan_company'];
 const snapshot=async(client:Pick<typeof target.client,'unsafe'>)=>Object.fromEntries(await Promise.all(retainedTables.map(async table=>[table,await client.unsafe(`select to_jsonb(t)::text as value from public."${table}" t where tenant_id=$1::uuid order by to_jsonb(t)::text`,[base.tenantId])])));
 try{
  await admin.unsafe(`CREATE DATABASE "${dbName}"`);created=true;mkdirSync(join(directory,'meta'));
  for(const entry of journal.entries.slice(0,boundary))copyFileSync('db/migrations/'+entry.tag+'.sql',join(directory,entry.tag+'.sql'));
  writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,boundary)}));await migrate(target.db,{migrationsFolder:directory});
  // Valid original rows are copied with all native triggers enabled; no receipt or skipped DDL is manufactured.
  const tables=['tenant','company','department','person','app_user','role_assignment','job_grade','business_unit','reward_setup_grant','reward_library','reward_library_version','reward_policy_group','reward_policy_group_version','reward_policy_group_target','reward_plan_setup','reward_plan_company'];
  await target.client.begin(async tx=>{
   await tx`select set_config('app.tenant_id',${base.tenantId},true),set_config('app.user_id',${base.adminUserId},true),set_config('app.roles','super_admin',true),set_config('app.grants','[{"role":"super_admin","companyId":null}]',true)`;
   for(const table of tables){
    const rows=await owner.client.unsafe(`select to_jsonb(t)::text as value from public."${table}" t where "${table==='tenant'?'id':'tenant_id'}"=$1::uuid`,[base.tenantId]);
    if(rows.length)await tx.unsafe(`insert into public."${table}" select * from jsonb_populate_recordset(null::public."${table}",$1::jsonb)`,['['+rows.map(r=>String(r.value)).join(',')+']']);
   }
  });
  const before=await snapshot(target.client);expect(before.reward_plan_setup).toHaveLength(1);expect(before.reward_plan_company).toHaveLength(2);
  copyFileSync('db/migrations/6100_rewards_review_plans.sql',join(directory,'6100_rewards_review_plans.sql'));writeFileSync(join(directory,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,boundary+1)}));await migrate(target.db,{migrationsFolder:directory});
  expect(await snapshot(target.client)).toEqual(before);
  const projected=await target.client`select year,company_id,plan_version_id,salary_reviewed,bonus_reviewed from reward_plan_year_company where tenant_id=${base.tenantId} order by company_id`;
  expect(projected.map(r=>[r.year,r.company_id,r.plan_version_id,r.salary_reviewed,r.bonus_reviewed])).toEqual(targets.map(t=>[2026,t.companyId,original.versionId,true,true]).sort((a,b)=>String(a[1]).localeCompare(String(b[1]))));
  expect((await target.client`select count(*)::integer as n from reward_plan_year where tenant_id=${base.tenantId}`)[0].n).toBe(1);
 }finally{await target.client.end({timeout:5});if(created)await admin.unsafe(`DROP DATABASE "${dbName}" WITH (FORCE)`);await admin.end({timeout:5});rmSync(directory,{recursive:true,force:true});}
},180_000);
