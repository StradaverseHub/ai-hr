/** Native retained-fixture diagnosis; no production DDL or trigger replacement. */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('records native insert plans and row-trigger costs before another million-row setup',async()=>{
 await resetDb();const b=await seedBase(),count=5000,plans:Record<string,unknown>={};
 const explain=async(name:string,query:PromiseLike<readonly Record<string,unknown>[]>)=>{
  const rows=await query;const parsed=rows[0]['QUERY PLAN'];
  expect(Array.isArray(parsed)).toBe(true);
  const plan=(parsed as {Plan:Record<string,number>;'Execution Time':number}[])[0];
  plans[name]=plan;
  expect(plan.Plan['Actual Rows']).toBe(0);
  expect(plan['Execution Time']).toBeGreaterThan(0);
  if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'personnel-fixture-cost.json'),JSON.stringify({kind:'NATIVE_INSERT_DIAGNOSTIC_ONLY',count,allNativeTriggers:true,plans},null,2));
 };
 await explain('person',owner.client`explain (analyze,buffers,format json) insert into person(id,tenant_id,full_name,primary_email)
  select ('fa000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,'Fictional fixture cost '||n,'fixture-cost-'||n||'@example.invalid' from generate_series(1,${count}::int)n`);
 await explain('employment',owner.client`explain (analyze,buffers,format json) insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on)
  select ('fb000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,('fa000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,${b.companyId}::uuid,'COST'||n,'2020-01-01'::date from generate_series(1,${count}::int)n`);
 await explain('assignment',owner.client`explain (analyze,buffers,format json) insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from)
  select ${b.tenantId}::uuid,('fb000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,${b.companyId}::uuid,${b.deptA}::uuid,'full_time','2020-01-01'::date from generate_series(1,${count}::int)n`);
 const [result]=await owner.client`select count(*)::int as count from employment where tenant_id=${b.tenantId}::uuid`;
 expect(result.count).toBe(count);
},180000);
