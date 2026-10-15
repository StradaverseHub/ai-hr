/** Apply ONLY the new owner DDL as a real NOSUPERUSER/NOBYPASSRLS principal, rollback everything.
 * This is independent of the normal postgres-owned fixture schema and must never target production. */
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {owner,migrateTestDb,closeAll} from './harness';
const migration=readFileSync(new URL('../db/migrations/0551_overtime_patterns.sql',import.meta.url),'utf8');
beforeAll(migrateTestDb);afterAll(closeAll);
it('installs the OT owner under a restricted migration role with FORCE RLS and private helper boundaries',async()=>{
 const role='ot_migration_'+randomUUID().replaceAll('-',''),rollback=new Error('rollback-restricted-ot-install');let verified=false;
 try{await owner.db.transaction(async tx=>{
  // Existing 0551 objects belong to the throwaway template. Transaction rollback restores them.
  const functionNames=[...migration.matchAll(/CREATE (?:OR REPLACE )?FUNCTION app\.([a-z_]+)\(/g)].map(match=>match[1]);
  const functions=await tx.execute(sql`select p.oid::regprocedure::text as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname=any(${functionNames}::text[])`) as unknown as {signature:string}[];
  for(const fn of functions)await tx.execute(sql.raw('DROP FUNCTION '+fn.signature+' CASCADE'));
  const tables=[...migration.matchAll(/CREATE TABLE ([a-z_]+)\(/g)].map(match=>match[1]);
  for(const table of [...tables].reverse())await tx.execute(sql.raw('DROP TABLE IF EXISTS public.'+table+' CASCADE'));
  await tx.execute(sql.raw(`CREATE ROLE ${role} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOLOGIN NOBYPASSRLS`));
  await tx.execute(sql.raw(`GRANT USAGE,CREATE ON SCHEMA public,app TO ${role}`));
  await tx.execute(sql.raw(`GRANT SELECT,REFERENCES ON ALL TABLES IN SCHEMA public TO ${role}`));
  // Reuse the existing private canonical batch-lock owner from 0539; never expose it to app/PUBLIC.
  await tx.execute(sql.raw(`GRANT EXECUTE ON FUNCTION app.attendance_payroll_protection_rows(uuid) TO ${role}`));
  await tx.execute(sql.raw(`GRANT TRIGGER ON public.attendance,public.attendance_rule,public.attendance_rule_ot_row,public.attendance_punch,public.attendance_day_adjustment,public.attendance_correction,public.attendance_workflow_decision,public.payroll_batch,public.toil_accrual TO ${role}`));
  await tx.execute(sql.raw(`SET LOCAL ROLE ${role}`));
  for(const statement of migration.split('--> statement-breakpoint').map(s=>s.trim()).filter(Boolean))await tx.execute(sql.raw(statement));
  const actual=await tx.execute(sql`select rolname,rolsuper,rolbypassrls from pg_roles where rolname=current_user`) as unknown as {rolname:string;rolsuper:boolean;rolbypassrls:boolean}[];
  expect(actual).toEqual([{rolname:role,rolsuper:false,rolbypassrls:false}]);
  const installed=await tx.execute(sql`select c.relname,c.relrowsecurity,c.relforcerowsecurity,pg_get_userbyid(c.relowner) as owner,has_table_privilege('ai_hr_app',c.oid,'TRUNCATE') as trunc from pg_class c where c.relnamespace='public'::regnamespace and c.relname=any(${tables}::text[])`) as unknown as {relname:string;relrowsecurity:boolean;relforcerowsecurity:boolean;owner:string;trunc:boolean}[];
  expect(installed).toHaveLength(tables.length);for(const table of installed)expect(table).toMatchObject({owner:role,relrowsecurity:true,relforcerowsecurity:true,trunc:false});
  const helpers=await tx.execute(sql`select p.proname,p.prosecdef,p.proconfig,exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') as public_exec from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname=any(${functionNames}::text[])`) as unknown as {proname:string;prosecdef:boolean;proconfig:string[];public_exec:boolean}[];
  expect(helpers).toHaveLength(functionNames.length);for(const helper of helpers){expect(helper.public_exec).toBe(false);expect(helper.proconfig).toContain('search_path=pg_catalog, public, pg_temp');}
  verified=true;throw rollback;
 });}catch(error){if(error!==rollback)throw error;}
 expect(verified).toBe(true);
});
