import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import postgres from 'postgres';
import {applyIndexExpansion, parseIndex} from './index-expansion.mjs';

const sql = 'CREATE INDEX custom_report_occurrence_report_scheduled_id_idx ON public.custom_report_occurrence USING btree (report_id, scheduled_for DESC, id DESC);';
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
const actor = '30000000-0000-0000-0000-000000000000';
const report = '40000000-0000-0000-0000-000000000000';

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
    CREATE FUNCTION app.current_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('app.fixture_user',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA app TO ai_hr_app;
    CREATE TABLE public.tenant (id uuid PRIMARY KEY);
    CREATE TABLE public.custom_report (id uuid PRIMARY KEY,tenant_id uuid NOT NULL);
    GRANT SELECT ON custom_report TO ai_hr_app;
    ALTER TABLE custom_report ENABLE ROW LEVEL SECURITY;
    CREATE POLICY report_scope ON custom_report FOR SELECT USING (tenant_id=app.current_tenant_id());`);
  const statements = readFileSync('db/migrations/0546_employee_master_reports.sql','utf8').split('--> statement-breakpoint');
  const start = statements.findIndex(part=>part.includes('CREATE TABLE custom_report_occurrence'));
  const end = statements.findIndex(part=>part.includes('CREATE OR REPLACE FUNCTION app.custom_report_schedule_identity_guard'));
  assert(start>=0 && end>start);
  for (const statement of statements.slice(start,end)) await owner.unsafe(statement);
  await owner`INSERT INTO tenant(id) VALUES (${tenant}),(${other})`;
  await owner`INSERT INTO custom_report(id,tenant_id) VALUES (${report},${tenant})`;
  await owner`INSERT INTO custom_report_occurrence(id,tenant_id,schedule_id,report_id,schedule_revision,reviewed_digest,
    owner_user_id,recipient_user_id,recipient_employment_id,scheduled_for,report_version,consent_after_sequence,policy_after_sequence,
    consent_updated_at,policy_updated_at,consent_verified_at)
    SELECT md5(i::text)::uuid,CASE WHEN i%3=0 THEN ${tenant}::uuid ELSE ${other}::uuid END,
      md5('schedule'||i)::uuid,CASE WHEN i%25=0 THEN ${report}::uuid ELSE md5('report'||(i%100))::uuid END,
      md5('revision')::uuid,repeat('a',64),${actor},${actor},${actor},
      '2026-01-01'::timestamptz+(i/250)*interval '1 minute',1,0,0,now(),now(),now()
    FROM generate_series(1,50000) i`;
  await owner`ANALYZE custom_report_occurrence`;
  const scoped=(tenantId,callback)=>app.begin(async tx=>{
    await tx`SELECT set_config('app.fixture_tenant',${tenantId},true),set_config('app.fixture_user',${actor},true)`;
    return callback(tx);
  });
  const history=tenantId=>scoped(tenantId,tx=>tx`SELECT id,tenant_id FROM custom_report_occurrence
    WHERE report_id=${report} ORDER BY scheduled_for DESC,id DESC LIMIT 50`);
  const rights=()=>owner`SELECT relrowsecurity,relacl::text,(SELECT row_to_json(p) FROM pg_policies p
    WHERE tablename='custom_report_occurrence' AND policyname='custom_report_occurrence_read') AS policy
    FROM pg_class WHERE oid='custom_report_occurrence'::regclass`;
  const before=await history(tenant);
  const acl=await rights();
  assert.equal(before.length,50); assert(before.every(row=>row.tenant_id===tenant));
  const otherRows=await history(other);
  assert.equal(otherRows.length,50); assert(otherRows.every(row=>row.tenant_id===other));
  assert.equal((await history('00000000-0000-0000-0000-000000000000')).length,0);
  await owner.begin(async tx=>{
    await tx`LOCK TABLE custom_report_occurrence IN ROW EXCLUSIVE MODE`;
    await assert.rejects(applyIndexExpansion(owner,plan),{code:'55P03'});
  });
  await assert.rejects(applyIndexExpansion(owner,plan,{beforeCommit(){throw Error('rollback drill');}}),/rollback drill/);
  assert.equal((await owner`SELECT to_regclass(${index.index}) IS NULL AS missing`)[0].missing,true);
  assert.equal((await owner`SELECT count(*)::int AS rows FROM drizzle.__drizzle_migrations`)[0].rows,12);
  assert.deepEqual(await history(tenant),before);
  assert.equal((await applyIndexExpansion(owner,plan)).rows,13);
  assert.deepEqual(await rights(),acl);
  assert.deepEqual(await history(tenant),before);
  assert.equal((await history('00000000-0000-0000-0000-000000000000')).length,0);
  const query=await scoped(tenant,tx=>tx`EXPLAIN (FORMAT JSON) SELECT id,status,scheduled_for,row_count,reason
    FROM custom_report_occurrence WHERE report_id=${report} ORDER BY scheduled_for DESC,id DESC LIMIT 50`);
  assert(JSON.stringify(query).includes(index.index), JSON.stringify(query));
  assert.equal((await applyIndexExpansion(owner,plan)).applied,false);
  console.log(JSON.stringify({migration:lastTag,sqlSha256:index.digest,populatedRows:50000,rollback:true,lockRefusal:true,unchangedTenantResults:true,newIndexUsed:true}));
});
