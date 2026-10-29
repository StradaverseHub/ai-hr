import {randomUUID,createHash} from 'node:crypto';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {drizzle} from 'drizzle-orm/postgres-js';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {eq,sql} from 'drizzle-orm';
import {testConnection} from '../core/ai-config';
import {withTenant} from '../db/client';
import {aiModelRun} from '../db/schema';
import {openaiAdapter} from '../lib/ai/providers/openai';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
let base:Base;
beforeAll(migrateTestDb);
beforeEach(async()=>{await resetDb();base=await seedBase();});
afterAll(closeAll);
const rows=()=>owner.db.select().from(aiModelRun).where(eq(aiModelRun.tenantId,base.tenantId));
describe('connection probe ledger (R9)',()=>{
 it.each([true,false])('commits pending receipt before transport and settles ok=%s with no credential or workload content',async ok=>{
  const validate=vi.spyOn(openaiAdapter,'validate').mockImplementation(async()=>{
   const pending=await rows();expect(pending).toHaveLength(1);expect(pending[0]).toMatchObject({operation:'probe',state:'pending',reservedTokens:0,userId:base.adminUserId});return {ok};
  });
  try{expect(await testConnection(adminCtx(base),{provider:'openai',model:'gpt-5.5',apiKey:'fictional-probe-key'})).toEqual({ok});}finally{validate.mockRestore();}
  const stored=await rows();expect(stored).toHaveLength(1);expect(stored[0]).toMatchObject({featureId:'provider_evaluation',operation:'probe',state:ok?'completed':'failed',actualTokens:null});
  expect(JSON.stringify(stored)).not.toContain('fictional-probe-key');
  const usage=await withTenant(adminCtx(base),tx=>tx.execute(sql`select * from app.ai_feature_usage()`));expect(usage).toHaveLength(0);
  const [money]=await withTenant(adminCtx(base),tx=>tx.execute<{unknown:string}>(sql`select app.ai_optional_spend_status()->>'unpricedUnknownRuns' as unknown`));expect(money.unknown).toBe('0');
 });
 it('refuses a no-login actor and direct app-role receipt forgery',async()=>{
  const ctx={...adminCtx(base),userId:undefined},validate=vi.spyOn(openaiAdapter,'validate');
  try{await expect(testConnection(ctx,{provider:'openai',model:'gpt-5.5',apiKey:'fictional'})).rejects.toThrow();expect(validate).not.toHaveBeenCalled();}finally{validate.mockRestore();}
  await expect(withTenant(adminCtx(base),tx=>tx.execute(sql`insert into ai_model_run(tenant_id,feature_id,operation,provider,model,state,reserved_tokens) values(${base.tenantId}::uuid,'provider_evaluation','probe','openai','fixture','completed',0)`))).rejects.toThrow();
  expect(await rows()).toHaveLength(0);
 });
 it('upgrades a populated immutable source baseline and preserves its existing usage receipt',async()=>{
  const folder=mkdtempSync(join(tmpdir(),'ai-probe-baseline-'));
  const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8'));
  const tag='0678_ai_connection_probe_ledger';
  expect(journal.entries.filter((entry:{tag:string})=>entry.tag===tag)).toHaveLength(1);
  const probeIndex=journal.entries.findIndex((entry:{tag:string})=>entry.tag===tag);expect(probeIndex).toBeGreaterThan(0);
  const entry=journal.entries[probeIndex],latest=journal.entries.at(-1);
  const prior={...journal,entries:journal.entries.slice(0,probeIndex)};
  mkdirSync(join(folder,'meta'));writeFileSync(join(folder,'meta/_journal.json'),JSON.stringify(prior));
  for(const item of prior.entries)copyFileSync(`db/migrations/${item.tag}.sql`,join(folder,`${item.tag}.sql`));
  const name='ai_probe_upgrade_'+randomUUID().replaceAll('-','');
  const url=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);url.pathname='/'+name;
  await owner.client.unsafe(`CREATE DATABASE "${name}"`);
  const upgrade=postgres(url.toString(),{max:1});
  try{
   await migrate(drizzle(upgrade),{migrationsFolder:folder});
   const [missing]=await upgrade`select to_regprocedure('app.ai_probe_start(text,text)')::text as name`;expect(missing.name).toBeNull();
   const tenantId=randomUUID(),runId=randomUUID();
   await upgrade`insert into tenant(id,workos_org_id,name) values(${tenantId}::uuid,${'org_'+tenantId},'Fictional upgrade tenant')`;
   await upgrade`insert into ai_model_run(id,tenant_id,feature_id,operation,provider,model,state,reserved_tokens,actual_tokens)
    values(${runId}::uuid,${tenantId}::uuid,'pay_rule_draft','draft','openai','fictional-upgrade','completed',100,17)`;
   const before=await upgrade`select * from ai_model_run where id=${runId}::uuid`;expect(before).toHaveLength(1);
   expect(Number(before[0].actual_tokens)).toBe(17);
   await migrate(drizzle(upgrade),{migrationsFolder:'db/migrations'});
   expect(await upgrade`select * from ai_model_run where id=${runId}::uuid`).toEqual(before);
   const [applied]=await upgrade`select hash,created_at from drizzle.__drizzle_migrations order by created_at desc limit 1`;
   expect(Number(applied.created_at)).toBe(latest.when);
   expect(applied.hash).toBe(createHash('sha256').update(readFileSync(`db/migrations/${latest.tag}.sql`)).digest('hex'));
   const [probeApplied]=await upgrade`select hash,created_at from drizzle.__drizzle_migrations where created_at=${entry.when}`;
   expect(Number(probeApplied.created_at)).toBe(entry.when);
   expect(probeApplied.hash).toBe(createHash('sha256').update(readFileSync(`db/migrations/${entry.tag}.sql`)).digest('hex'));
   const [count]=await upgrade`select count(*)::int as n from drizzle.__drizzle_migrations`;expect(count.n).toBe(journal.entries.length);
   const [present]=await upgrade`select to_regprocedure('app.ai_probe_start(text,text)')::text as name`;expect(present.name).not.toBeNull();
  }finally{
   await upgrade.end({timeout:5});
   try{await owner.client.unsafe(`DROP DATABASE "${name}" WITH (FORCE)`);}finally{rmSync(folder,{recursive:true,force:true});}
  }
 },90000);
 it('does not count probes against a daily user workload allowance',async()=>{
  const ctx=adminCtx(base);
  await withTenant(ctx,async tx=>{
   await tx.execute(sql`select app.ai_probe_start('openai','fixture')`);
   await tx.execute(sql`insert into ai_control_policy(tenant_id,scope_key,kind,subject_id,enabled,daily_requests) values(${base.tenantId}::uuid,${'user:'+base.adminUserId},'user',${base.adminUserId}::uuid,true,1)`);
   const admitted=await tx.execute<{allowed:boolean}>(sql`select * from app.ai_admit('pay_rule_draft','draft','openai','fixture',10,false)`);expect(admitted[0].allowed).toBe(true);
  });
 });
});
