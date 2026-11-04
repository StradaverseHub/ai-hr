/** Explicit hosted retained-data diagnosis only; native row triggers/constraints remain enabled. */
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {personnelListPage} from '../../core/read';
import {employmentStatusSql,type EmploymentStatusColumns} from '../../core/employment-status-sql';
import {lockAccessConfigurationReadTx} from '../../core/access-configuration-lock';
import {todayInKualaLumpur} from '../../lib/hr-date';
import {pgSqlState} from '../../lib/db-error';
import {accessConfigurationStore} from '../../core/access-configuration-store';
import {previewAccessConfiguration,saveAccessConfiguration} from '../../core/access-configuration';
import {withTenant,type SessionContext} from '../../db/client';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase} from '../harness';
const file='test/performance/personnel-projection-plan.test.ts';
const selected:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selected)&&selected.length===1&&selected[0]===file;
beforeAll(migrateTestDb);afterAll(closeAll);
it.skipIf(!requested)('compares late JSON projection with the original Personnel owner on fifty thousand retained employees',async()=>{
 const count=50_000,started=performance.now();
 const report:Record<string,unknown>={kind:'REVERSIBLE_PERSONNEL_LATE_JSON_COMPONENT_ONLY',releaseEligible:false,targetEmployees:count,concurrentUsers:1,queryTargetMs:1000,fixtureBatchRows:5000,nativeTriggers:'unchanged',limitations:'Retained synthetic owner fixture, not hiring/import throughput, browser timing, one-million Personnel or500-user capacity.'};
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'personnel-projection-plan.json'),JSON.stringify(report,null,2));
 const phase=(name:string)=>{report.phase=name;report.elapsedMs=performance.now()-started;save();};
 const measurements:{mode:string;originalElapsedMs:number;elapsedMs:number;total:number;pageRows:number;targetMet:boolean}[]=[];
 let ownsPrototypes=false;let originalDefinition:unknown;
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
  const companies=[b.companyId,foreign.companyId];
  const signatures=['app.performance_workforce_list_rows(uuid[])','app.performance_workforce_list_facts()'];
  const [existing]=await owner.client`select to_regprocedure(${signatures[0]})as rows,to_regprocedure(${signatures[1]})as facts`;
  expect(existing).toEqual({rows:null,facts:null});
  [originalDefinition]=await owner.client`select pg_get_functiondef(oid)as ddl,proacl::text as acl,proowner::regrole::text as owner from pg_proc where oid='app.access_workforce_list_rows()'::regprocedure`;
  ownsPrototypes=true;await owner.client.unsafe(readFileSync(new URL('./personnel-projection-plan.sql',import.meta.url),'utf8'));
  type Result=Awaited<ReturnType<typeof personnelListPage>>;
  const candidate=(q:string|undefined,offset:number):Promise<Result>=>withTenant(ctx,async tx=>{
   await lockAccessConfigurationReadTx(tx,ctx.tenantId);
   const dates:EmploymentStatusColumns={finalConfirmationDate:sql`workforce_row.final_confirmation_date`,confirmationDate:sql`workforce_row.confirmation_date`,probationEndDate:sql`workforce_row.probation_end_date`,provisionalEndOn:sql`workforce_row.provisional_end_on`,resignationDate:sql`workforce_row.resignation_date`,lastWorkingDate:sql`workforce_row.last_working_date`,terminatedOn:sql`workforce_row.terminated_on`,blacklistedAt:sql`workforce_row.blacklisted_at`};
   const status=employmentStatusSql(todayInKualaLumpur(),dates);
   const where=sql`workforce_row.company_id=any(array[${b.companyId}::uuid,${foreign.companyId}::uuid]) and ${q?sql`(workforce_row.name ilike ${'%'+q+'%'} or workforce_row.email ilike ${'%'+q+'%'} or workforce_row.employee_code ilike ${'%'+q+'%'})`:sql`true`}`;
   const [value]=await tx.execute<{rows:Result['rows'];total:number;status_counts:{status:keyof Result['headcount']['byStatus'];count:number}[]}>(sql`
    with workforce_facts as materialized(select * from app.performance_workforce_list_facts()),
    selected_page as materialized(
     select workforce_row.employment_id,workforce_row.name from workforce_facts workforce_row
     where ${where} order by workforce_row.name,workforce_row.employment_id limit 25 offset ${offset}
    ), page_rows as materialized(
     select value from app.performance_workforce_list_rows(array(select employment_id from selected_page)) r(value)
    )
    select coalesce((select jsonb_agg(p.value order by chosen.name,chosen.employment_id)
     from selected_page chosen join page_rows p on (p.value->>'employmentId')::uuid=chosen.employment_id),'[]'::jsonb)as rows,
    (select count(distinct workforce_row.employment_id)::int from workforce_facts workforce_row where ${where})as total,
    coalesce((select jsonb_agg(jsonb_build_object('status',s.status,'count',s.count)) from(
     select ${status}as status,count(distinct workforce_row.employment_id)::int as count
     from workforce_facts workforce_row where ${where} group by 1)s),'[]'::jsonb)as status_counts`);
   const byStatus:Result['headcount']['byStatus']={};let total=0;
   for(const row of value.status_counts){byStatus[row.status]=Number(row.count);total+=Number(row.count);}
   return {rows:value.rows,total:Number(value.total),headcount:{total,byStatus}};
  });
  const comparePoint=async(ids:string[])=>withTenant(ctx,async tx=>{
   await lockAccessConfigurationReadTx(tx,ctx.tenantId);
   const array=sql`array[${sql.join(ids.map(id=>sql`${id}::uuid`),sql`, `)}]::uuid[]`;
   const reference=await tx.execute<{value:Record<string,unknown>}>(sql`select value from app.access_workforce_list_rows() r(value)where (value->>'employmentId')::uuid=any(${array})order by value->>'employmentId'`);
   const current=await tx.execute<{value:Record<string,unknown>}>(sql`select value from app.performance_workforce_list_rows(${array})r(value)order by value->>'employmentId'`);
   expect(Array.from(current)).toEqual(Array.from(reference));return current.length;
  });
  expect(await comparePoint([expectedFirst[0],expectedFirst[0],foreignEmployment,randomUUID()])).toBe(1);
  expect(await comparePoint([])).toBe(0);
  const oversized=await withTenant(ctx,tx=>tx.execute(sql`select * from app.performance_workforce_list_rows(array(select ${expectedFirst[0]}::uuid from generate_series(1,2001)))`)).then(()=>null,(error:unknown)=>error);
  expect(pgSqlState(oversized)).toBe('22023');
  for(const signature of signatures){const [permission]=await owner.client`select has_function_privilege('ai_hr_app',p.oid,'EXECUTE')as app_execute,
   exists(select 1 from aclexplode(p.proacl)a where a.grantee=0 and a.privilege_type='EXECUTE')as public_execute from pg_proc p where p.oid=to_regprocedure(${signature})`;
   expect(permission).toEqual({app_execute:true,public_execute:false});}
  await withTenant({...adminCtx(foreign),grants:[{role:'hr_admin',companyId:null}]},async tx=>{
   const rows=await tx.execute(sql`select * from app.performance_workforce_list_rows(array[${expectedFirst[0]}::uuid])`);expect(rows).toHaveLength(0);
   const [facts]=await tx.execute<{count:number}>(sql`select count(*)::int as count from app.performance_workforce_list_facts()where company_id=${b.companyId}::uuid`);expect(facts.count).toBe(0);
  });
  // Compare every typed fact with the existing purpose projection, not just page IDs.
  const [factOracle]=await withTenant(ctx,async tx=>{
   await lockAccessConfigurationReadTx(tx,ctx.tenantId);
   return tx.execute<{mismatches:number;facts:number}>(sql`
    with reference as materialized(select value from app.access_workforce_list_rows()r(value)),
    facts as materialized(select * from app.performance_workforce_list_facts())
    select (select count(*)::int from facts)as facts,
     (select count(*)::int from facts f full join reference r on f.employment_id=(r.value->>'employmentId')::uuid
      where f.employment_id is null or r.value is null or
      jsonb_build_array(f.name,f.email,f.employee_code,f.company,f.company_id,f.department_id,f.employment_type,
       f.terminated_on,f.final_confirmation_date,f.confirmation_date,f.probation_end_date,f.provisional_end_on,
       f.resignation_date,f.last_working_date,f.blacklisted_at) is distinct from
      jsonb_build_array(r.value->'name',r.value->'email',r.value->'employeeCode',r.value->'company',
       r.value->'companyId',r.value->'departmentId',r.value->'employmentType',r.value->'terminatedOn',
       r.value->'finalConfirmationDate',r.value->'confirmationDate',r.value->'probationEndDate',
       r.value->'provisionalEndOn',r.value->'resignationDate',r.value->'lastWorkingDate',r.value->'blacklistedAt'))as mismatches`);
  });
  expect(factOracle).toEqual({facts:count,mismatches:0});report.factOracle=factOracle;
  for(const mode of ['initial','selective-search','deep-page']){
   const q=mode==='selective-search'?'PERF000050000':undefined,offset=mode==='deep-page'?count-25:0;
   phase(mode);const originalBegan=performance.now();
   const original=await personnelListPage(ctx,{companyIds:companies,q,limit:25,offset},{companyIds:companies,q});
   const originalElapsedMs=performance.now()-originalBegan,began=performance.now(),result=await candidate(q,offset);
   const elapsedMs=performance.now()-began,expectedTotal=q?1:count,expectedIds=q?[expectedLast.at(-1)!]:offset?expectedLast:expectedFirst;
   expect(result).toEqual(original);
   expect(result.total).toBe(expectedTotal);expect(result.headcount.total).toBe(expectedTotal);
   expect(Object.values(result.headcount.byStatus).reduce((sum,value)=>sum+Number(value??0),0)).toBe(expectedTotal);
   expect(result.rows.map(row=>row.employmentId)).toEqual(expectedIds);expect(result.rows.every(row=>row.employmentId!==foreignEmployment)).toBe(true);
   measurements.push({mode,originalElapsedMs,elapsedMs,total:result.total,pageRows:result.rows.length,targetMet:elapsedMs<1000});report.queries=measurements;save();
  }
  phase('measured');
  expect(measurements.every(row=>row.targetMet),'Each observed retained-data Personnel native query under1000ms').toBe(true);
  // Exercise a real Workforce-purpose revocation against the same stale SessionContext.
  // Only the isolated fixture capability is activated; no provider approval registry is changed.
  await owner.client`update access_capability set supported=true,
   bindings='[{"owner":"personnel-late-json-native-fixture","operation":"read-write"}]'::jsonb
   where id='workforce.view'`;
  expect((await candidate(undefined,0)).total).toBe(count);
  const before=await withTenant(ctx,tx=>accessConfigurationStore.loadCurrent(tx,ctx));
  const edit={expectedRevision:before.snapshot.revision,command:{kind:'setOverride' as const,
   userId:b.adminUserId,capabilityId:'workforce.view',companyId:b.companyId,effect:'deny' as const}};
  const preview=await previewAccessConfiguration(ctx,edit,accessConfigurationStore);
  await saveAccessConfiguration(ctx,{...edit,previewFingerprint:preview.fingerprint},accessConfigurationStore);
  const denied=await candidate(undefined,0);
  expect(denied).toEqual(await personnelListPage(ctx,{companyIds:companies,limit:25,offset:0},{companyIds:companies}));
  expect(denied).toEqual({rows:[],total:0,headcount:{total:0,byStatus:{}}});
  expect(await comparePoint([expectedFirst[0]])).toBe(0);
  report.nativePermissionRevocation='same stale context denied by original and both prototypes';
  phase('complete');
 }catch(error){report.errorType=(error as Error).name;phase('failed');throw error;}
 finally{
  if(ownsPrototypes){
   await owner.client.unsafe('DROP FUNCTION IF EXISTS app.performance_workforce_list_rows(uuid[]);DROP FUNCTION IF EXISTS app.performance_workforce_list_facts()');
   const [after]=await owner.client`select pg_get_functiondef(oid)as ddl,proacl::text as acl,proowner::regrole::text as owner from pg_proc where oid='app.access_workforce_list_rows()'::regprocedure`;
   expect(after).toEqual(originalDefinition);report.canonicalProjectionUnchanged=true;report.prototypeFunctionsDropped=true;
  }
  report.queries=measurements;save();
 }
},600000);
