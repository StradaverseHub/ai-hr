import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import {applyIndexExpansion, parseIndex} from './index-expansion.mjs';

const index = parseIndex(Buffer.from(
  'CREATE INDEX job_run_key_ran_at_id_idx ON public.job_run USING btree (job_key, ran_at DESC, id DESC);\n',
));
const original = [{tag: '0280_job_run', created_at: '1720000000000', hash: 'a'.repeat(64)}];
const row = {tag: 'fixture_order_index', created_at: '1720000000001', hash: index.digest};
const plan = {index, original, row, expanded: [...original, row]};

test('only a plain non-unique B-tree index is eligible', () => {
  for (const sql of [
    index.sql.replace('CREATE INDEX', 'CREATE UNIQUE INDEX'),
    index.sql.replace('CREATE INDEX', 'CREATE INDEX CONCURRENTLY'),
    index.sql.replace('job_key,', 'lower(job_key),'),
    index.sql + ' DROP TABLE public.job_run;',
    index.sql.replace('public.', 'drizzle.'),
  ]) assert.throws(() => parseIndex(Buffer.from(sql)), /non-unique public B-tree index/);
});

test('populated restricted-role upgrade proves lock refusal, rollback, RLS and query equivalence', async t => {
  const require = createRequire(import.meta.url);
  const postgres = require('postgres');
  assert(process.env.AIHR_UPGRADE_FIXTURE_URL, 'Disposable CI database required');
  const adminUrl = new URL(process.env.AIHR_UPGRADE_FIXTURE_URL);
  assert.equal(adminUrl.hostname, '127.0.0.1');
  assert.equal(adminUrl.pathname, '/upgrade_fixture');
  const connect = (user, password) => postgres({...connection(adminUrl), username: user, password, max: 4});
  const admin = connect(adminUrl.username, adminUrl.password);
  const owner = connect('ai_hr_owner', 'fixture-owner');
  const app = connect('ai_hr_app', 'fixture-app');
  t.after(async () => { await Promise.all([admin.end(), owner.end(), app.end()]); });

  await admin.unsafe(`
    CREATE ROLE ai_hr_owner LOGIN PASSWORD 'fixture-owner';
    CREATE ROLE ai_hr_app LOGIN PASSWORD 'fixture-app';
    GRANT USAGE, CREATE ON SCHEMA public TO ai_hr_owner;
    CREATE SCHEMA app AUTHORIZATION ai_hr_owner;
    CREATE SCHEMA drizzle AUTHORIZATION ai_hr_owner;
  `);
  await owner.unsafe(`CREATE FUNCTION app.is_group_admin() RETURNS boolean LANGUAGE sql STABLE
    AS $$ SELECT current_setting('app.fixture_group_admin', true) = 'yes' $$;
    GRANT USAGE ON SCHEMA app TO ai_hr_app;
    CREATE TABLE drizzle.__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
    INSERT INTO drizzle.__drizzle_migrations (hash,created_at) VALUES ('${original[0].hash}',${original[0].created_at});
  `);
  for (const statement of readFileSync('db/migrations/0280_job_run.sql','utf8').split('--> statement-breakpoint')) {
    await owner.unsafe(statement);
  }
  await owner`INSERT INTO public.job_run (id, job_key, ran_at, outcome)
    SELECT md5(i::text)::uuid, CASE WHEN i%5=0 THEN 'review.sweep' ELSE 'leave.accrue' END,
      '2026-01-01'::timestamptz + (i/50)*interval '1 hour', 'success'
    FROM generate_series(1,50000) i`;
  await owner`ANALYZE public.job_run`;

  const read = sql => sql`SELECT id FROM public.job_run WHERE job_key='review.sweep'
    ORDER BY ran_at DESC,id DESC LIMIT 10`;
  const readAsAdmin = () => app.begin(async tx => {
    await tx`SET LOCAL app.fixture_group_admin = 'yes'`;
    return read(tx);
  });
  const history = () => owner`SELECT hash, created_at::text FROM drizzle.__drizzle_migrations ORDER BY id`;
  const acl = () => owner`SELECT relacl::text, relrowsecurity,
    (SELECT row_to_json(p) FROM pg_policies p WHERE p.tablename='job_run' AND p.policyname='job_run_read') AS policy
    FROM pg_class WHERE oid='public.job_run'::regclass`;
  const before = {rows: await readAsAdmin(), ledger: await history(), acl: await acl()};
  assert.equal(before.rows.length, 10);
  assert.equal((await read(app)).length, 0);
  await assert.rejects(async () => app`INSERT INTO public.job_run(job_key,outcome) VALUES('review.sweep','success')`, {code: '42501'});
  await assert.rejects(applyIndexExpansion(admin, plan), /restricted migration owner/);

  await owner.begin(async blocker => {
    await blocker`LOCK TABLE public.job_run IN ROW EXCLUSIVE MODE`;
    await assert.rejects(applyIndexExpansion(owner, plan), {code: '55P03'});
  });
  await assert.rejects(applyIndexExpansion(owner, plan, {
    beforeCommit() { throw new Error('Inject rollback after both writes'); },
  }), /Inject rollback/);
  assert.deepEqual(await history(), before.ledger);
  assert.equal((await owner`SELECT to_regclass('public.job_run_key_ran_at_id_idx') IS NULL AS absent`)[0].absent, true);
  assert.deepEqual(await readAsAdmin(), before.rows);

  const applied = await applyIndexExpansion(owner, plan);
  assert.equal(applied.applied, true);
  assert.equal(applied.rows, 2);
  assert.deepEqual(await readAsAdmin(), before.rows);
  assert.equal((await read(app)).length, 0);
  assert.deepEqual(await acl(), before.acl);
  const [query] = await owner`EXPLAIN (FORMAT JSON) SELECT id FROM public.job_run
    WHERE job_key='review.sweep' ORDER BY ran_at DESC,id DESC LIMIT 10`;
  assert.match(JSON.stringify(query), /job_run_key_ran_at_id_idx/);
  assert.equal((await applyIndexExpansion(owner,plan)).applied, false);
  console.log(JSON.stringify({populatedRows:50000,transactionRollback:true,lockRefusal:true,
    oldQueryOnNewSchema:true,restrictedRole:true,outputAndPermissionsUnchanged:true,elapsedMs:applied.elapsedMs}));
});

function connection(url) {
  return {host:url.hostname, port:Number(url.port), database:url.pathname.slice(1)};
}
