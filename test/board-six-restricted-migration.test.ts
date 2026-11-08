/** Disposable hosted upgrade: unchanged release SQL, a real restricted LOGIN and temporary DBA prerequisites. */
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import postgres from 'postgres';
import {migrate} from 'drizzle-orm/postgres-js/migrator';
import {drizzle} from 'drizzle-orm/postgres-js';
import {expect,it} from 'vitest';

it('upgrades the exact seven migrations under restricted ownership and removes every temporary role privilege',async()=>{
 const expected3701='4d8969bfc0b8f134f8cc01c42a738eb6cc4babdcb1ccfb0ec824a61d9b9fee11';
 expect(createHash('sha256').update(readFileSync('db/migrations/3701_rewards_unit_preparation.sql')).digest('hex')).toBe(expected3701);
 const journal=JSON.parse(readFileSync('db/migrations/meta/_journal.json','utf8'));
 expect(journal.entries).toHaveLength(717);expect(journal.entries[710].tag).toBe('3700_pay_item_company_applicability');
 const url=new URL(process.env.TEST_MIGRATION_DATABASE_URL!);expect(['localhost','127.0.0.1']).toContain(url.hostname);
 const adminUrl=new URL(url);adminUrl.pathname='/postgres';const admin=postgres(adminUrl.toString(),{max:1,onnotice:()=>{}});
 const name='ai_hr_six_role_upgrade_'+randomUUID().replaceAll('-',''),login='six_migrator_'+randomUUID().replaceAll('-','');
 const quote=(s:string)=>'"'+s.replaceAll('"','""')+'"';
 const roleNames=['ai_hr_reward_preparation_reader','ai_hr_reward_preparation_invalidator','ai_hr_company_org_source_reader'];
 const dir=mkdtempSync(join(tmpdir(),'aihr-six-restricted-'));mkdirSync(join(dir,'meta'));
 url.pathname='/'+name;const db=postgres(url.toString(),{max:1,onnotice:()=>{}});
 let restricted:ReturnType<typeof postgres>|undefined,created=false,ownerCreated=false,loginCreated=false,prepared=false;
 const roleSnapshot=()=>admin`select r.rolname,a.member::regrole::text member,a.inherit_option,a.set_option,a.admin_option from pg_auth_members a join pg_roles r on r.oid=a.roleid where r.rolname=any(${roleNames}::text[]) order by r.rolname,a.member`;
 const originalEdges=await roleSnapshot();expect(originalEdges).toEqual([]);
 const ownerBefore=await admin`select rolname,rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,rolinherit from pg_roles where rolname='ai_hr_owner'`;
 try{
  if(!ownerBefore.length){await admin.unsafe('CREATE ROLE ai_hr_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT');ownerCreated=true;}
  const [ownerAttrs]=await admin`select rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls from pg_roles where rolname='ai_hr_owner'`;
  expect(ownerAttrs).toEqual({rolsuper:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false,rolbypassrls:false});
  await admin.unsafe(`CREATE DATABASE ${quote(name)}`);created=true;
  for(const e of journal.entries.slice(0,710))copyFileSync('db/migrations/'+e.tag+'.sql',join(dir,e.tag+'.sql'));
  writeFileSync(join(dir,'meta/_journal.json'),JSON.stringify({...journal,entries:journal.entries.slice(0,710)}));
  await migrate(drizzle(db),{migrationsFolder:dir});
  await admin.unsafe(`ALTER DATABASE ${quote(name)} OWNER TO ai_hr_owner`);
  // Project only this disposable database's ordinary administrator-owned objects to the real restricted owner.
  // Never REASSIGN OWNED: that can transfer shared databases and objects outside this fixture.
  await db.unsafe(`DO $project$ DECLARE r record; me oid:=(SELECT oid FROM pg_roles WHERE rolname=current_user); BEGIN
   FOR r IN SELECT nspname FROM pg_namespace WHERE nspname IN('public','app','drizzle') LOOP EXECUTE format('ALTER SCHEMA %I OWNER TO ai_hr_owner',r.nspname); END LOOP;
   FOR r IN SELECT c.relname,n.nspname,c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('public','app','drizzle') AND c.relowner=me AND c.relkind IN('r','p','v','m','S') ORDER BY CASE WHEN c.relkind='S' THEN 1 ELSE 0 END,c.oid LOOP
    EXECUTE format('ALTER %s %I.%I OWNER TO ai_hr_owner',CASE r.relkind WHEN 'S' THEN 'SEQUENCE' WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' ELSE 'TABLE' END,r.nspname,r.relname);
   END LOOP;
   FOR r IN SELECT p.oid::regprocedure::text signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='app' AND p.proowner=me LOOP EXECUTE format('ALTER FUNCTION %s OWNER TO ai_hr_owner',r.signature); END LOOP;
   FOR r IN SELECT t.typname,n.nspname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname IN('public','app') AND t.typowner=me AND t.typtype IN('e','d') LOOP EXECUTE format('ALTER TYPE %I.%I OWNER TO ai_hr_owner',r.nspname,r.typname); END LOOP;
  END $project$;`);
  await admin.unsafe(`CREATE ROLE ${quote(login)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);loginCreated=true;
  await admin.unsafe(`GRANT ai_hr_owner TO ${quote(login)} WITH INHERIT FALSE, SET TRUE, ADMIN FALSE`);
  const restrictedUrl=new URL(url);restrictedUrl.username=login;restrictedUrl.password='';
  restricted=postgres(restrictedUrl.toString(),{max:1,onnotice:()=>{}});
  await restricted.unsafe('SET ROLE ai_hr_owner');
  const [session]=await restricted`select current_user as database_role,session_user as login_name,(select rolsuper or rolcreaterole or rolcreatedb or rolbypassrls from pg_roles where rolname=session_user) as elevated`;
  expect(session).toEqual({database_role:'ai_hr_owner',login_name:login,elevated:false});
  const tenant=randomUUID(),company=randomUUID(),user=randomUUID();
  await db.begin(async tx=>{
   await tx`insert into tenant(id,workos_org_id,name) values(${tenant},${randomUUID()},'Fictional restricted migration')`;
   await tx`insert into company(id,tenant_id,legal_name,country,currency) values(${company},${tenant},'Fictional restricted upgrade','MY','MYR')`;
   await tx`insert into app_user(id,tenant_id,workos_user_id) values(${user},${tenant},${randomUUID()})`;
  });
  // This operational fixture preserves nonempty existing rows. Native Rewards population and
  // confidentiality cases remain the separate unchanged release qualification.
  const snapshot=async()=>({companies:await db`select * from company where tenant_id=${tenant} order by id`,users:await db`select * from app_user where tenant_id=${tenant} order by id`,tenants:await db`select * from tenant where id=${tenant}`});
  const before=await snapshot();expect(before.companies).toHaveLength(1);expect(before.users).toHaveLength(1);expect(before.tenants).toHaveLength(1);
  const ledger=()=>db`select id::text,hash,created_at::text from drizzle.__drizzle_migrations order by drizzle.__drizzle_migrations.id`;
  const prefix=await ledger();expect(prefix).toHaveLength(710);
  // Missing owner-transfer privileges reproduce the restricted installation failure and roll back fully.
  await expect(migrate(drizzle(restricted),{migrationsFolder:'db/migrations'})).rejects.toMatchObject({cause:expect.objectContaining({code:'42501',message:expect.stringMatching(/must be able to SET ROLE|must be member of role/)})});
  expect(await ledger()).toEqual(prefix);expect(await snapshot()).toEqual(before);
  const prepare=readFileSync('deploy/runner-control/board-six-role-prerequisite.sql','utf8');
  await db.begin(async tx=>{await tx.unsafe(prepare);});prepared=true;
  // A real failed ordinary migration must not strand the temporary owner-transfer privileges.
  await db.unsafe("CREATE FUNCTION public.six_fixture_migration_refusal() RETURNS event_trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Fictional migration refusal after prerequisite' USING ERRCODE='23514'; END $$; CREATE EVENT TRIGGER six_fixture_migration_refusal ON ddl_command_start WHEN TAG IN ('CREATE FUNCTION') EXECUTE FUNCTION public.six_fixture_migration_refusal();");
  try{await expect(migrate(drizzle(restricted),{migrationsFolder:'db/migrations'})).rejects.toMatchObject({cause:expect.objectContaining({code:'23514'})});}
  finally{await db.unsafe('DROP EVENT TRIGGER six_fixture_migration_refusal; DROP FUNCTION public.six_fixture_migration_refusal();');}
  expect(await ledger()).toEqual(prefix);expect(await snapshot()).toEqual(before);
  await db.begin(async tx=>{await tx.unsafe(readFileSync('deploy/runner-control/board-six-role-failure-cleanup.sql','utf8'));});prepared=false;
  expect(await roleSnapshot()).toEqual(originalEdges);
  expect(await db`select has_schema_privilege(oid,'app','CREATE') as can_create from pg_roles where rolname=any(${roleNames}::text[])`).toEqual(roleNames.map(()=>({can_create:false})));
  // Cleanup also covers a partial cleanup: memberships removed while schema CREATE remains.
  await db.begin(async tx=>{await tx.unsafe(prepare);});prepared=true;
  await admin.unsafe('REVOKE ai_hr_reward_preparation_reader,ai_hr_reward_preparation_invalidator,ai_hr_company_org_source_reader FROM ai_hr_owner');
  await db.begin(async tx=>{await tx.unsafe(readFileSync('deploy/runner-control/board-six-role-failure-cleanup.sql','utf8'));});prepared=false;
  expect(await roleSnapshot()).toEqual(originalEdges);
  expect(await db`select has_schema_privilege(oid,'app','CREATE') as can_create from pg_roles where rolname=any(${roleNames}::text[])`).toEqual(roleNames.map(()=>({can_create:false})));
  await db.begin(async tx=>{await tx.unsafe(prepare);});prepared=true;
  await migrate(drizzle(restricted),{migrationsFolder:'db/migrations'});
  const after=await ledger();expect(after).toHaveLength(717);expect(after.slice(0,710)).toEqual(prefix);
  expect(await snapshot()).toEqual(before);
  await db.begin(async tx=>{await tx.unsafe(readFileSync('deploy/runner-control/board-six-role-postflight.sql','utf8'));});prepared=false;
  expect(await roleSnapshot()).toEqual(originalEdges);
  expect(await db`select rolname,has_schema_privilege(oid,'app','CREATE') as can_create,pg_has_role('ai_hr_app',oid,'MEMBER') as app_member from pg_roles where rolname=any(${roleNames}::text[]) order by rolname`).toEqual(roleNames.slice().sort().map(rolname=>({rolname,can_create:false,app_member:false})));
  expect(await db`select pg_has_role('ai_hr_app','ai_hr_owner','MEMBER') as app_owner`).toEqual([{app_owner:false}]);
 }finally{
  if(restricted)await restricted.end({timeout:5});
  if(prepared){await admin.unsafe('REVOKE ai_hr_reward_preparation_reader,ai_hr_reward_preparation_invalidator,ai_hr_company_org_source_reader FROM ai_hr_owner');await db.unsafe('REVOKE CREATE ON SCHEMA app FROM ai_hr_reward_preparation_reader,ai_hr_reward_preparation_invalidator,ai_hr_company_org_source_reader');}
  await db.end({timeout:5});if(created)await admin.unsafe(`DROP DATABASE ${quote(name)}`);
  if(loginCreated)await admin.unsafe(`DROP ROLE ${quote(login)}`);
  if(ownerCreated)await admin.unsafe('DROP ROLE ai_hr_owner');
  await admin.end({timeout:5});rmSync(dir,{recursive:true,force:true});
 }
},120000);
