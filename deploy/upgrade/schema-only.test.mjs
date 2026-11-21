import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import postgres from 'postgres';
import {applyIndexExpansion, parseIndex} from './index-expansion.mjs';

const sql = 'CREATE INDEX clocking_import_run_tenant_created_id_idx ON public.clocking_import_run USING btree (tenant_id, created_at DESC, id DESC);';
const journal = JSON.parse(readFileSync('db/migrations/meta/_journal.json'));
const lastTag = journal.entries.at(-1).tag;
const pilot = process.env.GITHUB_REF_NAME?.startsWith('codex/staging-schema-only-');
const index = parseIndex(pilot ? readFileSync(`db/migrations/${lastTag}.sql`) : Buffer.from(sql+'\n'));
assert.equal(index.sql, sql, 'A rehearsal may only attest the exact reviewed migration');
const old = Array.from({length:12}, (_, i)=>({tag:`prior_${i}`,hash:'a'.repeat(64),created_at:String(1720000000000+i)}));
const newRow = {tag:lastTag,hash:index.digest,created_at:'1720000000012'};
const plan = {index,original:old,expanded:[...old,newRow],row:newRow};
const tenant = '10000000-0000-0000-0000-000000000000';
const other = '20000000-0000-0000-0000-000000000000';

test('exact index changes the plan on 50,000 rows without changing tenant visibility or rollback', async t=>{
  const url = new URL(process.env.AIHR_UPGRADE_FIXTURE_URL);
  assert.equal(url.hostname,'127.0.0.1');
  assert.equal(url.pathname,'/upgrade_fixture');
  const admin = postgres(url.href,{max:1,onnotice:()=>{}});
  const connect = (username,password)=>postgres({host:url.hostname,port:url.port,database:'upgrade_fixture',username,password,max:4,onnotice:()=>{}});
  const owner = connect('ai_hr_owner','owner');
  const app = connect('ai_hr_app','app');
  t.after(async()=>Promise.all([admin.end(),owner.end(),app.end()]));
  await admin.unsafe(`CREATE ROLE ai_hr_owner LOGIN PASSWORD 'owner'; CREATE ROLE ai_hr_app LOGIN PASSWORD 'app';
    GRANT USAGE,CREATE ON SCHEMA public TO ai_hr_owner;
    CREATE SCHEMA app AUTHORIZATION ai_hr_owner; CREATE SCHEMA drizzle AUTHORIZATION ai_hr_owner;`);
  await owner.unsafe(`CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
    INSERT INTO drizzle.__drizzle_migrations (hash,created_at) SELECT '${old[0].hash}',1720000000000+n FROM generate_series(0,11) n ORDER BY n;
    CREATE FUNCTION app.current_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.fixture_tenant',true),'')::uuid $$;
    CREATE FUNCTION app.is_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT current_setting('app.fixture_admin',true)='yes' $$;
    GRANT USAGE ON SCHEMA app TO ai_hr_app;
    CREATE TABLE public.tenant (id uuid PRIMARY KEY);
    CREATE TABLE public.person (id uuid PRIMARY KEY);
    CREATE TABLE public.clocking_file_mapping (id uuid PRIMARY KEY);`);
  const statements = readFileSync('db/migrations/0518_clocking_file_import.sql','utf8').split('--> statement-breakpoint');
  const start = statements.findIndex(part=>part.includes('CREATE TABLE IF NOT EXISTS clocking_import_run'));
  const end = statements.findIndex(part=>part.includes('CREATE TABLE IF NOT EXISTS clocking_import_line'));
  assert(start>=0 && end>start);
  for (const statement of statements.slice(start,end)) await owner.unsafe(statement);
  await owner`INSERT INTO tenant(id) VALUES (${tenant}),(${other})`;
  await owner`INSERT INTO clocking_import_run(id,tenant_id,created_at,mapping_name)
    SELECT md5(i::text)::uuid,CASE WHEN i%3=0 THEN ${tenant}::uuid ELSE ${other}::uuid END,
    '2026-01-01'::timestamptz+(i/3000)*interval '1 minute','fixture' FROM generate_series(1,50000) i`;
  await owner`ANALYZE clocking_import_run`;
  const history=(tenantId,allowed)=>app.begin(async tx=>{
    await tx`SELECT set_config('app.fixture_tenant',${tenantId},true),set_config('app.fixture_admin',${allowed},true)`;
    return tx`SELECT id,tenant_id FROM clocking_import_run ORDER BY created_at DESC,id DESC LIMIT 200`;
  });
  const rights=()=>owner`SELECT relrowsecurity,relacl::text,(SELECT row_to_json(p) FROM pg_policies p
    WHERE tablename='clocking_import_run' AND policyname='clocking_import_run_rls') AS policy FROM pg_class WHERE oid='clocking_import_run'::regclass`;
  const before=await history(tenant,'yes');
  const acl=await rights();
  assert.equal(before.length,200); assert(before.every(row=>row.tenant_id===tenant));
  const otherRows=await history(other,'yes');
  assert.equal(otherRows.length,200); assert(otherRows.every(row=>row.tenant_id===other));
  assert.equal((await history(tenant,'no')).length,0);
  await owner.begin(async tx=>{
    await tx`LOCK TABLE clocking_import_run IN ROW EXCLUSIVE MODE`;
    await assert.rejects(applyIndexExpansion(owner,plan),{code:'55P03'});
  });
  await assert.rejects(applyIndexExpansion(owner,plan,{beforeCommit(){throw Error('rollback drill');}}),/rollback drill/);
  assert.equal((await owner`SELECT to_regclass(${index.index}) IS NULL AS missing`)[0].missing,true);
  assert.equal((await owner`SELECT count(*)::int AS rows FROM drizzle.__drizzle_migrations`)[0].rows,12);
  assert.deepEqual(await history(tenant,'yes'),before);
  assert.equal((await applyIndexExpansion(owner,plan)).rows,13);
  assert.deepEqual(await rights(),acl);
  assert.deepEqual(await history(tenant,'yes'),before);
  assert.equal((await history(tenant,'no')).length,0);
  const query=await app.begin(async tx=>{
    await tx`SELECT set_config('app.fixture_tenant',${tenant},true),set_config('app.fixture_admin','yes',true)`;
    return tx`EXPLAIN (FORMAT JSON) SELECT id,tenant_id FROM clocking_import_run ORDER BY created_at DESC,id DESC LIMIT 200`;
  });
  assert(JSON.stringify(query).includes(index.index), JSON.stringify(query));
  assert.equal((await applyIndexExpansion(owner,plan)).applied,false);
  console.log(JSON.stringify({migration:lastTag,sqlSha256:index.digest,populatedRows:50000,rollback:true,lockRefusal:true,unchangedTenantResults:true,newIndexUsed:true}));
});
