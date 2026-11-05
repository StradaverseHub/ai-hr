/** Explicit hosted retained-data diagnosis only; native row triggers/constraints remain enabled. */
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {readWorkforcePickRowsTx} from '../../core/read';
import {lockAccessConfigurationReadTx} from '../../core/access-configuration-lock';
import {withTenant,type SessionContext} from '../../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
const file='test/performance/workforce-bounded-read-plan.test.ts';
const selected:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selected)&&selected.length===1&&selected[0]===file;
beforeAll(migrateTestDb);afterAll(closeAll);
it.skipIf(!requested)('compares a bounded native Workforce reader with disjoint full-list and selected-ID plans',async()=>{
 const count=50_000,started=performance.now();
 const report:Record<string,unknown>={kind:'WORKFORCE_BOUNDED_READ_PLAN_COMPONENT_ONLY',releaseEligible:false,targetEmployees:count,concurrentUsers:1,queryTargetMs:1000,fixtureBatchRows:5000,nativeTriggers:'unchanged',limitations:'Retained synthetic owner fixture, not hiring/import throughput, browser timing, one-million Personnel or500-user capacity.'};
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'workforce-bounded-read-plan.json'),JSON.stringify(report,null,2));
 const phase=(name:string)=>{report.phase=name;report.elapsedMs=performance.now()-started;save();};

 try{
  expect(process.env.AIHR_FOCUSED_EVIDENCE_DIR).toBeTruthy();
  await resetDb();const b=await seedBase(),foreign=await seedBase();
  const ctx:SessionContext={...adminCtx(b),grants:[{role:'hr_admin',companyId:null}]};
  const expectedFirst:string[]=[],expectedLast:string[]=[];
  for(let offset=0;offset<count;offset+=5000){
   const end=offset+5000,personPrefix=randomUUID().slice(0,24),employmentPrefix=randomUUID().slice(0,24);
   report.currentFixtureBatch={from:offset+1,to:end};phase('fixture');
   await owner.client.begin(async tx=>{
    await tx`insert into person(id,tenant_id,full_name,primary_email)
     select (${personPrefix}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,
      'Fictional retained Personnel '||lpad(n::text,9,'0'),(${personPrefix}||lpad(n::text,12,'0'))||'@example.invalid'
     from generate_series(${offset+1}::integer,${end}::integer)n`;
    await tx`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on,terminated_on)
     select (${employmentPrefix}||lpad(n::text,12,'0'))::uuid,${b.tenantId}::uuid,(${personPrefix}||lpad(n::text,12,'0'))::uuid,
      ${b.companyId}::uuid,'PERF'||lpad(n::text,9,'0'),'2020-01-01'::date,
      case when n%5=0 then '2024-01-01'::date else null end from generate_series(${offset+1}::integer,${end}::integer)n`;
    await tx`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from)
     select ${b.tenantId}::uuid,(${employmentPrefix}||lpad(n::text,12,'0'))::uuid,${b.companyId}::uuid,
      ${b.deptA}::uuid,'full_time','2020-01-01'::date from generate_series(${offset+1}::integer,${end}::integer)n`;
   });
   if(offset===0)for(let n=1;n<=25;n++)expectedFirst.push(employmentPrefix+String(n).padStart(12,'0'));
   if(end===count)for(let n=count-24;n<=count;n++)expectedLast.push(employmentPrefix+String(n).padStart(12,'0'));
   report.committedFixtureEmployees=end;save();
  }
  const foreignPerson=randomUUID(),foreignEmployment=randomUUID();
  await owner.client`insert into person(id,tenant_id,full_name,primary_email) values(${foreignPerson}::uuid,${foreign.tenantId}::uuid,'Fictional outside Personnel',${foreignPerson+'@example.invalid'})`;
  await owner.client`insert into employment(id,tenant_id,person_id,company_id,hired_on) values(${foreignEmployment}::uuid,${foreign.tenantId}::uuid,${foreignPerson}::uuid,${foreign.companyId}::uuid,'2020-01-01')`;
  for(const table of ['person','employment','assignment','company','department','app_user','role_assignment'])await owner.client.unsafe('analyze '+table);
  const [counts]=await owner.client`select (select count(*)::int from employment where tenant_id=${b.tenantId}::uuid) as employees,(select count(*)::int from assignment where tenant_id=${b.tenantId}::uuid)as assignments`;
  expect(counts).toEqual({employees:count,assignments:count});report.retainedCounts=counts;report.fixturePreparationMs=performance.now()-started;
  const [identity]=await withTenant(ctx,tx=>tx.execute<{role:string}>(sql`select current_user as role`));expect(identity.role).toBe('ai_hr_app');

  const [installed]=await owner.client<{ddl:string;body:string;owner:string;acl:string|null}[]>`select pg_get_functiondef(oid)as ddl,prosrc as body,proowner::regrole::text as owner,proacl::text as acl from pg_proc where oid='app._access_workforce_list_rows(uuid[])'::regprocedure`;
  const predecessorSql=readFileSync(new URL('../../db/migrations/2129_personnel_native_paging.sql',import.meta.url),'utf8');
  const predecessorBody=predecessorSql.split('AS $$')[1].split('$$;')[0];
  const original={...installed,body:predecessorBody,ddl:installed.ddl.replace(installed.body,()=>predecessorBody)};
  const needle=' FROM public.employment e JOIN permitted allowed ON allowed.id=e.company_id';
  expect(original.ddl.split(needle)).toHaveLength(2);
  // Keep the single JSON projection and every purpose/tenant/voided/subject predicate.
  // Only the employment source is split into mutually exclusive branches, allowing the
  // selected-ID branch to plan an indexed lookup without the full-list OR condition.
  const proposal=JSON.parse(readFileSync(new URL('./workforce-bounded-migration.proposal.json',import.meta.url),'utf8')) as {sql:string};
  const candidate=proposal.sql;
  expect(readFileSync(new URL('../../db/migrations/2139_workforce_bounded_read_plan.sql',import.meta.url),'utf8')).toBe(candidate);
  expect(installed.body).toBe(candidate.split('AS $$')[1].split('$$;')[0]);
  expect(candidate.split('AS $$')[1]?.split('$$;')[0]).toBe(original.body.replace(needle,` FROM (
    SELECT * FROM public.employment WHERE subject_ids IS NULL
    UNION ALL
    SELECT * FROM public.employment WHERE subject_ids IS NOT NULL AND id=ANY(subject_ids)
   )e JOIN permitted allowed ON allowed.id=e.company_id`));
  const ids=[...expectedFirst,expectedFirst[0],foreignEmployment,randomUUID()];
  const read=()=>withTenant(ctx,tx=>readWorkforcePickRowsTx(ctx,tx,ids));
  const full=()=>withTenant(ctx,async tx=>{
   await lockAccessConfigurationReadTx(tx,ctx.tenantId);
   return tx.execute<{rows:number;digest:string}>(sql`select count(*)::int as rows,md5(string_agg(md5(value::text),''order by value->>'employmentId',value::text))as digest from app.access_workforce_list_rows()r(value)`);
  });
  const expected=await read(),fullExpected=await full();
  expect(expected.map(row=>row.employmentId)).toEqual([...expectedFirst].sort());expect(fullExpected[0].rows).toBe(count);
  const measurements:unknown[]=[];
  try{
   for(const step of ['original','candidate','candidate-warm','restored']as const){
    phase(step);if(step==='original')await owner.client.unsafe(original.ddl);
    if(step==='candidate')await owner.client.unsafe(candidate);
    if(step==='restored')await owner.client.unsafe(original.ddl);
    const began=performance.now();for(let index=0;index<25;index++)expect(await read()).toEqual(expected);
    measurements.push({phase:step,reads:25,elapsedMs:performance.now()-began,exactSelectedRows:true});
    expect(await full()).toEqual(fullExpected);
    const empty=await withTenant(ctx,tx=>tx.execute(sql`select value from app.access_workforce_list_rows_for_ids(null::uuid[])r(value)`));expect(empty).toHaveLength(0);
    const [metadata]=await owner.client`select proowner::regrole::text as owner,proacl::text as acl,has_function_privilege('ai_hr_app',oid,'EXECUTE')as app_execute from pg_proc where oid='app._access_workforce_list_rows(uuid[])'::regprocedure`;
    expect(metadata).toEqual({owner:original.owner,acl:original.acl,app_execute:false});
    report.measurements=measurements;report.fullListDigestUnchanged=true;save();
    if(step==='candidate'){
     await owner.client`update app_user set archived_at=now()where id=${b.adminUserId}::uuid`;
     try{expect(await read()).toHaveLength(0);}finally{await owner.client`update app_user set archived_at=null where id=${b.adminUserId}::uuid`;}
     const forged={...ctx,userId:foreign.adminUserId};
     expect(await withTenant(forged,tx=>readWorkforcePickRowsTx(forged,tx,ids))).toHaveLength(0);
     report.archivedAndForgedActorsRefused=true;
    }
   }
  }finally{
   await owner.client.unsafe(installed.ddl);
   const [restored]=await owner.client`select pg_get_functiondef(oid)as ddl,prosrc as body,proowner::regrole::text as owner,proacl::text as acl from pg_proc where oid='app._access_workforce_list_rows(uuid[])'::regprocedure`;
   expect(restored).toEqual(installed);report.installedFunctionRestored=true;save();
  }
  const drifts=[
   ['body',original.ddl.replace(original.body,()=>original.body+'\n-- unreviewed predecessor probe\n')],
   ['volatility','alter function app._access_workforce_list_rows(uuid[]) volatile'],
   ['application-execute','grant execute on function app._access_workforce_list_rows(uuid[]) to ai_hr_app'],
   ['public-execute','grant execute on function app._access_workforce_list_rows(uuid[]) to public'],
   ['configuration','alter function app._access_workforce_list_rows(uuid[]) set search_path=public,pg_temp'],
  ];
  for(const [,ddl]of drifts){
   await expect(owner.client.begin(async tx=>{await tx.unsafe(original.ddl);await tx.unsafe(ddl);await tx.unsafe(candidate);})).rejects.toMatchObject({code:'55000'});
   const [after]=await owner.client`select pg_get_functiondef(oid)as ddl,prosrc as body,proowner::regrole::text as owner,proacl::text as acl from pg_proc where oid='app._access_workforce_list_rows(uuid[])'::regprocedure`;
   expect(after).toEqual(installed);
  }
  report.predecessorDriftsRefused=drifts.map(([kind])=>kind);
  phase('complete');
 }catch(error){report.errorType=(error as Error).name;phase('failed');throw error;}
 finally{save();}
},600000);
