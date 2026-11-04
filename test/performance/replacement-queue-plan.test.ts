/** Reversible query-shape experiment; no installed migration or permission change. */
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from '../harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('compares exact subject and tenant-wide replacement queue effects with an explicit subject branch',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase();
 const [original]=await owner.client`select pg_get_functiondef(oid) as ddl from pg_proc where oid='app.enqueue_replacement_holidays()'::regprocedure`;
 const statement=`INSERT INTO replacement_holiday_queue(tenant_id,employment_id)
 SELECT e.tenant_id,e.id FROM employment e WHERE e.tenant_id=tid AND (eid IS NULL OR e.id=eid)
 ON CONFLICT(tenant_id,employment_id) DO UPDATE SET generation=replacement_holiday_queue.generation+1,requested_at=now(),claimed_at=NULL,claimed_generation=NULL;`;
 expect(original.ddl).toContain(statement);
 const candidate=original.ddl.replace(statement,`IF eid IS NULL THEN\n${statement}\nELSE\n${statement.replace('(eid IS NULL OR e.id=eid)','e.id=eid')}\nEND IF;`);
 const measurements:Record<string,unknown>[]=[];
 const population=async(base:Base,prefix:string,size:number)=>{
  await owner.client`insert into person(id,tenant_id,full_name,primary_email) select (${prefix}||lpad(n::text,12,'0'))::uuid,${base.tenantId}::uuid,'Fictional queue profile '||n,${prefix}||n||'@example.invalid' from generate_series(1,${size}::int)n`;
  const start=performance.now();
  await owner.client`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on) select (${prefix}||lpad(n::text,12,'0'))::uuid,${base.tenantId}::uuid,(${prefix}||lpad(n::text,12,'0'))::uuid,${base.companyId}::uuid,${prefix}||n,'2020-01-01'::date from generate_series(1,${size}::int)n`;
  return performance.now()-start;
 };
 try{
  await population(foreign,'fc000000-0000-4000-8000-',1);
  measurements.push({phase:'original',insertMs:await population(b,'fd000000-0000-4000-8000-',5000)});
  await owner.client.unsafe(candidate);
  measurements.push({phase:'candidate',insertMs:await population(b,'fe000000-0000-4000-8000-',5000)});
  // An exact-subject update increments only that employee; company updates still enqueue the whole tenant.
  const rows=()=>owner.client`select tenant_id,employment_id,generation::int from replacement_holiday_queue order by tenant_id,employment_id`;
  const before=await rows();expect(before).toHaveLength(10001);
  await owner.client`update employment set employee_code=employee_code||'X' where id='fe000000-0000-4000-8000-000000000001'::uuid`;
  const afterSubject=await rows();
  expect(afterSubject.map((row,i)=>row.generation-before[i].generation)).toEqual(before.map(row=>row.employment_id==='fe000000-0000-4000-8000-000000000001'?1:0));
  await owner.client`update company set legal_name=legal_name||' profile' where id=${b.companyId}::uuid`;
  const afterTenant=await rows();
  expect(afterTenant.map((row,i)=>row.generation-afterSubject[i].generation)).toEqual(before.map(row=>row.tenant_id===b.tenantId?1:0));
 }finally{
  await owner.client.unsafe(original.ddl);
  const [restored]=await owner.client`select pg_get_functiondef('app.enqueue_replacement_holidays()'::regprocedure)as ddl`;
  expect(restored.ddl).toBe(original.ddl);
  if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'replacement-queue-plan.json'),JSON.stringify({kind:'REVERSIBLE_QUERY_EXPERIMENT_ONLY',measurements,restored:restored.ddl===original.ddl},null,2));
 }
},180000);
