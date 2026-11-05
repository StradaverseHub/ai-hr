/** Installed private plan, actual Workforce purpose and unchanged public bounds. */
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {withTenant} from '../db/client';
import {hireEmployee} from '../core/org';
import {readWorkforcePickRowsTx} from '../core/read';
import {pgSqlState} from '../lib/db-error';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('retains selected/full purpose scope, private EXECUTE and public NULL/empty/size contracts',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase(),ctx=adminCtx(b);
 const employees=[];
 for(let index=0;index<5;index++)employees.push(await hireEmployee(ctx,{person:{fullName:'Fictional bounded subject '+index,primaryEmail:randomUUID()+'@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'}));
 const [installed]=await owner.client<{body:string;owner:string;app_execute:boolean;public_execute:boolean}[]>`select prosrc as body,proowner::regrole::text as owner,has_function_privilege('ai_hr_app',oid,'EXECUTE')as app_execute,exists(select 1 from aclexplode(proacl)a where a.grantee=0 and a.privilege_type='EXECUTE')as public_execute from pg_proc where oid='app._access_workforce_list_rows(uuid[])'::regprocedure`;
 const proposal=JSON.parse(readFileSync(new URL('./performance/workforce-bounded-migration.proposal.json',import.meta.url),'utf8')) as {sql:string};
 expect(readFileSync(new URL('../db/migrations/2139_workforce_bounded_read_plan.sql',import.meta.url),'utf8')).toBe(proposal.sql);
 expect(installed.body).toBe(proposal.sql.split('AS $$')[1].split('$$;')[0]);
 expect(installed.app_execute).toBe(false);expect(installed.public_execute).toBe(false);
 const ids=[employees[1].employmentId,employees[3].employmentId,employees[1].employmentId,randomUUID()];
 const rows=await withTenant(ctx,tx=>readWorkforcePickRowsTx(ctx,tx,ids));
 expect(rows.map(row=>row.employmentId)).toEqual([employees[1].employmentId,employees[3].employmentId].sort());
 const whole=await withTenant(ctx,tx=>tx.execute<{value:Record<string,unknown>}>(sql`select value from app.access_workforce_list_rows()r(value)`));
 const expected=whole.filter(row=>ids.includes(String(row.value.employmentId))).map(({value})=>Object.fromEntries(['employmentId','name','employeeCode','companyId','company','department','terminatedOn'].map(key=>[key,value[key]]))).sort((a,b)=>String(a.employmentId).localeCompare(String(b.employmentId)));
 expect(rows).toEqual(expected);
 expect(await withTenant(adminCtx(foreign),tx=>readWorkforcePickRowsTx(adminCtx(foreign),tx,ids))).toEqual([]);
 expect(await withTenant(ctx,tx=>tx.execute(sql`select value from app.access_workforce_list_rows_for_ids(null::uuid[])r(value)`))).toHaveLength(0);
 expect(await withTenant(ctx,tx=>tx.execute(sql`select value from app.access_workforce_list_rows_for_ids(array[]::uuid[])r(value)`))).toHaveLength(0);
 for(const [label,query,code]of [
  ['private',sql`select value from app._access_workforce_list_rows(array[${ids[0]}::uuid])r(value)`,'42501'],
  ['size',sql`select value from app.access_workforce_list_rows_for_ids(array_fill(${ids[0]}::uuid,array[2001]))r(value)`,'22023'],
 ]as const){
  let refused=false;try{await withTenant(ctx,tx=>tx.execute(query));}catch(error){refused=true;expect(pgSqlState(error),label).toBe(code);}expect(refused,label).toBe(true);
 }
 await owner.client`update app_user set archived_at=now()where id=${b.adminUserId}::uuid`;
 try{expect(await withTenant(ctx,tx=>readWorkforcePickRowsTx(ctx,tx,ids))).toEqual([]);}finally{await owner.client`update app_user set archived_at=null where id=${b.adminUserId}::uuid`;}
});
