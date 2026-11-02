/** ADR-0170 step 5a — ordinary journal upgrade over a populated database through this branch's appended
 *  tail (0890 outcome record and mandates, 0891 rule-version labels). Proves: existing leave policy and
 *  approval rows get version 1 without any data change, the version triggers fire after the upgrade, the new
 *  tables arrive with RLS and exactly the intended grants, and a second migrate is a no-op. Hosted only. */
import {randomUUID,createHash} from 'node:crypto';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {eq,sql} from 'drizzle-orm';
import type {PgTable} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createDb} from '../db/client';
import * as schema from '../db/schema';
import {setLeaveApprovalPolicy} from '../packs/leave/service';
import {adminCtx,closeAll,owner,resetDb,seedBase} from './harness';
beforeAll(async()=>{await resetDb();});afterAll(closeAll);

const TAIL=[['0924_teras_outcome_record_mandates','1793330000324'],['0925_teras_rule_version_labels','1793330000325']] as const;
it('applies the Teras tail from 0890/0891 on over populated leave policy and approval rows, versioning them at 1 without changing them',async()=>{
 const sourceUrl=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);
 expect(['127.0.0.1','localhost']).toContain(sourceUrl.hostname);expect(sourceUrl.pathname).toMatch(/^\/ai_hr_test/);
 const name='ai_hr_teras_upgrade_'+randomUUID().replaceAll('-','');
 const adminUrl=new URL(sourceUrl);adminUrl.pathname='/postgres';const admin=postgres(adminUrl.toString(),{max:1});
 const destinationUrl=new URL(sourceUrl);destinationUrl.pathname='/'+name;
 const preDirectory=mkdtempSync(join(tmpdir(),'aihr-teras-pre0890-'));
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8'));
 // The tail starts at 0890/0891; later appended Teras migrations (0895, 0901, 0905, 0906) are applied with it.
 const start=journal.entries.findIndex((entry:{tag:string})=>entry.tag===TAIL[0][0]);
 const tail=journal.entries.slice(start) as {tag:string;when:number}[];
 expect(start).toBeGreaterThan(0);expect(tail.slice(0,TAIL.length).map(entry=>[entry.tag,String(entry.when)])).toEqual(TAIL);
 const installed=journal.entries.slice(0,start);
 mkdirSync(join(preDirectory,'meta'));writeFileSync(join(preDirectory,'meta','_journal.json'),JSON.stringify({...journal,entries:installed}));
 for(const entry of installed)copyFileSync(join('db/migrations',entry.tag+'.sql'),join(preDirectory,entry.tag+'.sql'));
 let target:ReturnType<typeof createDb>|undefined;
 try{
  await admin.unsafe(`CREATE DATABASE "${name}"`);target=createDb(destinationUrl.toString(),{max:1});
  await migrate(target.db,{migrationsFolder:preDirectory});
  const beforeLedger=await target.db.execute<{hash:string;created_at:string}>(sql`select hash,created_at::text from drizzle.__drizzle_migrations order by created_at,id`);
  expect((await target.db.execute(sql`select to_regclass('public.teras_outcome_record') as relation`))[0]).toMatchObject({relation:null});

  // Populate through the real owners, then copy the graph in FK order with every trigger enabled.
  const b=await seedBase();const ctx=adminCtx(b);
  await setLeaveApprovalPolicy(ctx,{companyId:b.companyId,levels:['direct_manager','hr_admin']});
  await owner.db.insert(schema.leaveApprovalTemplate).values({tenantId:b.tenantId,name:'Fictional upgrade chain',levels:['hr_admin'],isTenantDefault:true});
  const tables:PgTable[]=[schema.tenant,schema.company,schema.department,schema.person,schema.appUser,schema.roleAssignment,schema.leaveType,schema.leaveApprovalTemplate,schema.leaveApprovalPolicy];
  for(const table of tables){const rows=await owner.db.select().from(table).where(table===schema.tenant?eq(schema.tenant.id,b.tenantId):sql`tenant_id=${b.tenantId}::uuid`);if(rows.length)await target.db.insert(table).values(rows);}
  const snapshot=async()=>{const out:Record<string,unknown>={};
   for(const table of ['leave_type','leave_approval_policy','leave_approval_template'])out[table]=await target!.client.unsafe(`select to_jsonb(t)-'rule_version' as value from public.${table} t order by id`);
   return out;};
  const old=await snapshot();expect((old.leave_type as unknown[]).length).toBeGreaterThan(0);expect(old.leave_approval_policy as unknown[]).toHaveLength(1);

  await migrate(target.db,{migrationsFolder:'db/migrations'});
  expect(await snapshot()).toEqual(old);
  const afterLedger=await target.db.execute<{hash:string;created_at:string}>(sql`select hash,created_at::text from drizzle.__drizzle_migrations order by created_at,id`);
  expect(afterLedger.slice(0,installed.length)).toEqual(beforeLedger);
  expect(afterLedger.slice(installed.length)).toEqual(tail.map(({tag,when})=>({hash:createHash('sha256').update(readFileSync(`db/migrations/${tag}.sql`)).digest('hex'),created_at:String(when)})));
  for(const table of ['leave_type','leave_approval_policy','leave_approval_template']){
   expect(await target.client.unsafe(`select distinct rule_version from public.${table}`)).toEqual([{rule_version:1}]);
  }
  await target.client.unsafe(`update public.leave_approval_policy set levels='["hr_admin"]'::jsonb`);
  expect(await target.client.unsafe(`select rule_version from public.leave_approval_policy`)).toEqual([{rule_version:2}]);
  const grants=await target.client.unsafe(`select c.relname as table,c.relrowsecurity as rls,
    has_table_privilege('ai_hr_app',c.oid,'SELECT') as s,has_table_privilege('ai_hr_app',c.oid,'INSERT') as i,
    has_table_privilege('ai_hr_app',c.oid,'UPDATE') as u,has_table_privilege('ai_hr_app',c.oid,'DELETE') as d,has_table_privilege('ai_hr_app',c.oid,'TRUNCATE') as t
   from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r' and c.relname like 'teras\\_%' order by c.relname`);
  expect(grants).toEqual([
   {table:'teras_mandate',rls:true,s:true,i:true,u:true,d:false,t:false},
   {table:'teras_mandate_control',rls:true,s:true,i:true,u:true,d:false,t:false},
   {table:'teras_mandate_job_type_enablement',rls:true,s:true,i:true,u:true,d:false,t:false},
   {table:'teras_outcome_followup',rls:true,s:true,i:true,u:false,d:false,t:false},
   {table:'teras_outcome_record',rls:true,s:true,i:true,u:false,d:false,t:false},
   {table:'teras_task_memory',rls:true,s:true,i:true,u:true,d:true,t:false},
   // 0895: the registry's worker switches (GRANT SELECT, INSERT, UPDATE).
   {table:'teras_worker_control',rls:true,s:true,i:true,u:true,d:false,t:false},
  ]);
  await migrate(target.db,{migrationsFolder:'db/migrations'});
  expect(await target.db.execute(sql`select hash,created_at::text from drizzle.__drizzle_migrations order by created_at,id`)).toEqual(afterLedger);
 }finally{
  if(target)await target.client.end();await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);await admin.end();rmSync(preDirectory,{recursive:true,force:true});
 }
},180000);
