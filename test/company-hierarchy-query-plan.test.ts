/** Actual migrated plan reuse must retain the SQL owner and observe live changes on one connection. */
import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {eq,sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as s from '../db/schema';
import {hireEmployee} from '../core/org';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('retains the complete canonical expression and native non-language attributes',async()=>{
 const source=readFileSync('db/migrations/0312_invitation_privilege_escalation.sql','utf8');
 const match=source.match(/CREATE OR REPLACE FUNCTION app\.is_company_descendant\(child uuid, ancestor uuid\)[\s\S]*?AS \$\$([\s\S]*?)\$\$;/);
 expect(match).not.toBeNull();const body=match![1];
 expect(createHash('sha256').update(body).digest('hex')).toBe('2966296c5a5c1f383e92fc88816b5dfc07c3794d78877b17d0db1d0d1668a670');
 const [row]=await owner.client`select p.prosrc as body,l.lanname as language,p.provolatile,p.prosecdef,p.proleakproof,p.proisstrict,p.proparallel,p.proconfig,
 has_function_privilege('ai_hr_app',p.oid,'EXECUTE') as app_execute from pg_proc p join pg_language l on l.oid=p.prolang where p.oid='app.is_company_descendant(uuid,uuid)'::regprocedure`;
 expect(row).toEqual({body:'BEGIN\n RETURN (\n'+body.replace(/;\s*$/,'')+'\n );\nEND;',language:'plpgsql',provolatile:'s',prosecdef:true,proleakproof:false,proisstrict:false,proparallel:'u',proconfig:['search_path=pg_catalog, public, pg_temp'],app_execute:true});
});
it('keeps ancestry, tenant RLS and same-connection grants/hierarchy changes live',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase(),ctx=adminCtx(b);
 const companies=[b.companyId];
 for(let i=0;i<3;i++){const [row]=await owner.db.insert(s.company).values({tenantId:b.tenantId,country:'MY',legalName:'Fictional hierarchy plan '+i,parentCompanyId:i<2?companies[i]:null}).returning();companies.push(row.id);}
 const ids:string[]=[];
 for(let i=0;i<companies.length;i++){
  const [department]=await owner.db.insert(s.department).values({tenantId:b.tenantId,companyId:companies[i],name:'Fictional hierarchy department '+i}).returning();
  const row=await hireEmployee(ctx,{person:{fullName:'Fictional hierarchy subject '+i,primaryEmail:randomUUID()+'@example.test'},companyId:companies[i],departmentId:department.id,employmentType:'full_time',hiredOn:'2020-01-01'});ids.push(row.employmentId);
 }
 await hireEmployee(adminCtx(foreign),{person:{fullName:'Fictional other tenant',primaryEmail:randomUUID()+'@example.test'},companyId:foreign.companyId,departmentId:foreign.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const scoped:SessionContext={...ctx,grants:[{role:'hr_admin',companyId:b.companyId}]};
 await withTenant(scoped,async tx=>{
  const visible=async()=>{const rows=await tx.execute<{id:string}>(sql`select id from employment order by id`);return rows.map(row=>row.id);};
  const ancestry=async(child:string|null,parent:string|null)=>{const [row]=await tx.execute<{allowed:boolean}>(sql`select app.is_company_descendant(${child}::uuid,${parent}::uuid) as allowed`);return row.allowed;};
  expect(await ancestry(companies[2],companies[0])).toBe(true);expect(await ancestry(companies[0],companies[2])).toBe(false);
  expect(await ancestry(companies[2],foreign.companyId)).toBe(false);expect(await ancestry(null,companies[0])).toBe(false);expect(await ancestry(companies[0],null)).toBe(false);
  const absent=randomUUID();expect(await ancestry(absent,absent)).toBe(false);
  expect(await visible()).toEqual(ids.slice(0,3).sort());
  await owner.db.update(s.company).set({parentCompanyId:null}).where(eq(s.company.id,companies[1]));
  expect(await ancestry(companies[2],companies[0])).toBe(false);expect(await visible()).toEqual([ids[0]]);
  await owner.db.update(s.company).set({parentCompanyId:companies[0]}).where(eq(s.company.id,companies[1]));
  expect(await ancestry(companies[2],companies[0])).toBe(true);expect(await visible()).toEqual(ids.slice(0,3).sort());
  await tx.execute(sql`select set_config('app.grants','[]',true)`);expect(await visible()).toEqual([]);
  await tx.execute(sql`select set_config('app.grants',${JSON.stringify([{role:'hr_admin',companyId:null}])},true)`);expect(await visible()).toEqual([...ids].sort());
 });
 await expect(withTenant(scoped,async tx=>{await tx.execute(sql`select set_config('app.grants','{broken',true)`);return tx.execute(sql`select app.visible_employment_ids()`);})).rejects.toMatchObject({cause:{code:'22P02'}});
});
