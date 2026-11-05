/** Native catalogue predecessor only. No policy/function/schema/role mutation. */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {closeAll,migrateTestDb,owner} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('records exact native financial read predicates, owners, ACLs and validated relationship constraints',async()=>{
 const policies=await owner.db.execute(sql`select c.relname,p.polname,p.polcmd,p.polpermissive,p.polroles::text,
 pg_get_expr(p.polqual,p.polrelid) as using_expression,pg_get_expr(p.polwithcheck,p.polrelid) as check_expression
 from pg_policy p join pg_class c on c.oid=p.polrelid join pg_namespace n on n.oid=c.relnamespace
 where n.nspname='public' and c.relname in('payslip','employment','company','person','app_user','compensation','employee_statutory_my') order by c.relname,p.polname`);
 const tables=await owner.db.execute(sql`select c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relowner::regrole::text as owner,c.relacl::text
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in('payslip','employment','company','person','app_user') order by c.relname`);
 const constraints=await owner.db.execute(sql`select conrelid::regclass::text as relation,conname,contype,convalidated,condeferrable,condeferred,pg_get_constraintdef(oid) as definition
 from pg_constraint where conrelid in('public.payslip'::regclass,'public.employment'::regclass,'public.company'::regclass,'public.app_user'::regclass) order by conrelid::regclass::text,conname`);
 const columns=await owner.db.execute(sql`select attrelid::regclass::text as relation,attname,attnotnull,atttypid::regtype::text as type,attgenerated
 from pg_attribute where attrelid in('public.payslip'::regclass,'public.employment'::regclass,'public.company'::regclass) and attname in('id','tenant_id','employment_id','company_id','person_id','batch_id','voided_at') and not attisdropped order by attrelid::regclass::text,attname`);
 const signatures=['app.can_admin_payroll_employment(uuid)','app.can_admin_payroll_for(uuid)','app.is_self_person(uuid)','app.current_grants()','app.grants_payroll_admin_for(jsonb,uuid)','app.payroll_history_effective(uuid)','app.payroll_history_self_issued(uuid)','app.payroll_tax_basis_reader_compatible(uuid,uuid)'];
 const functions=[];for(const signature of signatures){const [row]=await owner.db.execute(sql`select oid::regprocedure::text as signature,proowner::regrole::text as owner,proacl::text,prosecdef,provolatile,proconfig,prorettype::regtype::text as returns,md5(prosrc) as body_md5,pg_get_functiondef(oid) as definition from pg_proc where oid=to_regprocedure(${signature})`);expect(row).toBeTruthy();functions.push(row);}
 if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'payroll-read-policy-predecessor.json'),JSON.stringify({kind:'NATIVE_PREDECESSOR_ONLY_NO_MUTATIONS',releaseEligible:false,policies,tables,constraints,columns,functions},null,2));
 expect(functions).toHaveLength(8);expect(policies.some(row=>row.relname==='payslip'&&row.polname==='payslip_rls')).toBe(true);
});
