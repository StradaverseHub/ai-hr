import {randomUUID} from 'node:crypto';
/** Explicit focused benchmark only. Synthetic retained rows do not measure hiring/import throughput. */
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import {withTenant} from '../../db/client';
import {personnelListPage} from '../../core/read';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from '../harness';
import {installPersonnelSearchProbe,readWithPersonnelSearchProbe,type SearchProbe} from './personnel-bounded-search-prototype';
const file='test/performance/personnel-retained-million.test.ts';
const selected:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&process.env.AIHR_RETAINED_PERSONNEL_MILLION==='true'&&Array.isArray(selected)&&selected.length===1&&selected.includes(file);
beforeAll(migrateTestDb);afterAll(closeAll);
it.skipIf(!requested)('verifies indexed Personnel search with exact early overflow over one million retained employees',async()=>{
 const count=1_000_000,started=performance.now();
 const report:Record<string,unknown>={kind:'RETAINED_PERSONNEL_SEARCH_ONLY',releaseEligible:false,targetEmployees:count,concurrentUsers:1,pageRows:25,fixtureBatchRows:5_000,fixturePreparationBudgetMs:2_700_000,queryTargetMs:1000,fixtureUuidLocality:'random v4 namespace per batch with ordered suffix; domains use distinct namespaces',limitations:'Search-only synthetic retained owner fixture. No initial/deep improvement, canonical hiring/import throughput, HTTP/browser timing or 500-user capacity claim.'};
 expect(process.env.AIHR_FOCUSED_EVIDENCE_DIR).toBeTruthy();
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'personnel-retained-million.json'),JSON.stringify(report,null,2));
 const phase=(name:string)=>{report.phase=name;report.elapsedMs=performance.now()-started;save();};
 const triggers:{name:string;ddl:string}[]=[],indexes:string[]=[];let probe:SearchProbe|undefined,extensionCreated=false,originalFunctions:unknown;
 const functions=()=>owner.client`select oid::regprocedure::text as identity,prosrc,proowner::regrole::text as owner,proacl::text as acl,proconfig,procost,prorows from pg_proc where oid=any(array['app.access_workforce_list_facts()'::regprocedure,'app.access_workforce_list_rows_for_ids(uuid[])'::regprocedure,'app._access_workforce_list_rows(uuid[])'::regprocedure])order by oid`;
 try{
  await resetDb();const b=await seedBase(),foreign=await seedBase(),ctx=adminCtx(b);originalFunctions=Array.from(await functions());
  const existing=await owner.client<{name:string;ddl:string}[]>`select c.relname as name,pg_get_triggerdef(t.oid)as ddl from pg_trigger t join pg_class c on c.oid=t.tgrelid where c.oid=any(array['public.person'::regclass,'public.employment'::regclass]) and t.tgname='assessment_reminder_touch' order by c.relname`;
  expect(existing.map(row=>row.name)).toEqual(['employment','person']);triggers.push(...existing);
  // Separately measured fixture optimization: exact per-row epoch increments are grouped
  // per statement. All other row triggers, FK checks and native constraints remain enabled.
  await owner.client.unsafe(readFileSync(new URL('./personnel-fixture-reminder-batch.sql',import.meta.url),'utf8'));
  report.fixtureCounterGuard='exact statement aggregation, independently verified under restricted owner in41785596183';
  async function population(base:Base,size:number){
   const expected:string[]=[],last:string[]=[];
   // Bound deferred-trigger/FK queues and transaction memory. Every row retains every native check.
   for(let offset=0;offset<size;offset+=5_000){
    const end=Math.min(size,offset+5_000),personPrefix=randomUUID().slice(0,24),employmentPrefix=randomUUID().slice(0,24);
    expect(performance.now()-started,'bounded retained fixture preparation').toBeLessThan(2_700_000);
    report.fixtureCurrentBatch={from:offset+1,to:end};
    await owner.client.begin(async tx=>{
     phase('retained-fixture-person');
     await tx`insert into person(id,tenant_id,full_name,primary_email)
      select (${personPrefix}||lpad(n::text,12,'0'))::uuid,${base.tenantId}::uuid,
       'Fictional retained Personnel '||lpad(n::text,9,'0'),(${personPrefix}||lpad(n::text,12,'0'))||'@example.invalid'
      from generate_series(${offset+1}::integer,${end}::integer) as n`;
     phase('retained-fixture-employment');
     await tx`insert into employment(id,tenant_id,person_id,company_id,employee_code,hired_on,terminated_on)
      select (${employmentPrefix}||lpad(n::text,12,'0'))::uuid,${base.tenantId}::uuid,(${personPrefix}||lpad(n::text,12,'0'))::uuid,
       ${base.companyId}::uuid,'PERF'||lpad(n::text,9,'0'),'2020-01-01'::date,
       case when n%5=0 then '2024-01-01'::date else null end from generate_series(${offset+1}::integer,${end}::integer) as n`;
     phase('retained-fixture-assignment');
     await tx`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from)
      select ${base.tenantId}::uuid,(${employmentPrefix}||lpad(n::text,12,'0'))::uuid,${base.companyId}::uuid,
       ${base.deptA}::uuid,'full_time','2020-01-01'::date from generate_series(${offset+1}::integer,${end}::integer) as n`;
    });
    if(offset===0)for(let n=1;n<=Math.min(size,25);n++)expected.push(employmentPrefix+String(n).padStart(12,'0'));
    if(end===size)for(let n=Math.max(1,size-24);n<=size;n++)last.push(employmentPrefix+String(n).padStart(12,'0'));
    if(base.tenantId===b.tenantId)report.committedFixtureEmployees=end;else report.committedForeignEmployees=end;phase('retained-fixture-batch-committed');
   }
   return {first:expected,last};
  }
  phase('retained-fixture-loading');const expected=await population(b,count);await population(foreign,1);
  for(const table of ['person','employment','assignment','company','department','app_user','role_assignment'])await owner.client.unsafe('analyze '+table);
  const [sizes]=await owner.client`select
   (select count(*)::int from person where tenant_id=${b.tenantId}::uuid) as people,
   (select count(*)::int from employment where tenant_id=${b.tenantId}::uuid) as employees,
   (select count(*)::int from assignment where tenant_id=${b.tenantId}::uuid) as assignments`;
  expect(sizes.employees).toBe(count);expect(sizes.assignments).toBe(count);report.retainedCounts=sizes;
  report.settings=await owner.client`select current_setting('fsync') as fsync,current_setting('synchronous_commit') as synchronous_commit,current_setting('shared_buffers') as shared_buffers,current_setting('work_mem') as work_mem`;
  const [identity]=await withTenant(ctx,tx=>tx.execute<{role:string}>(sql`select current_user as role`));expect(identity.role).toBe('ai_hr_app');
  report.fixturePreparationMs=performance.now()-started;const companies=[b.companyId,foreign.companyId];
  // Initial/deep use the same canonical source and are still unqualified. The earlier
  // same-population witness already measured them; do not spend fresh capacity on those controls here.
  report.unchangedUnqualifiedControls={source:'22255b8614520d50a7666083daf2df03963e5c0f',run:41972036625,
   initialMs:8993.483014000114,deepMs:17426.714581000153,targetMs:1000,initialTargetMet:false,deepTargetMet:false};
  phase('search-fixture-ready');
  const lastId=expected.last.at(-1)!;
  const [person]=await owner.client<{name:string;email:string}[]>`select p.full_name as name,p.primary_email as email from person p join employment e on e.person_id=p.id and e.tenant_id=p.tenant_id where e.id=${lastId}::uuid`;
  const changed=await owner.client`update employment set employee_code='LIMIT25-'||id::text where id=any(${expected.first}::uuid[]) returning id`;
  expect(changed).toHaveLength(25);report.fixtureSearchMarkerCount=changed.length;
  const [extension]=await owner.client`select exists(select 1 from pg_extension where extname='pg_trgm')as present`;
  if(!extension.present){await owner.client`create extension pg_trgm`;extensionCreated=true;}
  const names=['performance_personnel_million_person_gin','performance_personnel_million_code_gin'];
  for(const name of names){const [existing]=await owner.client`select to_regclass(${'public.'+name})as relation`;expect(existing.relation).toBeNull();}
  phase('qualified-search-index-build');const build=performance.now();
  await owner.client.unsafe('create index '+names[0]+' on public.person using gin(full_name gin_trgm_ops,primary_email gin_trgm_ops)');indexes.push(names[0]);
  await owner.client.unsafe('create index '+names[1]+' on public.employment using gin(employee_code gin_trgm_ops)');indexes.push(names[1]);
  report.searchIndexBuildMs=performance.now()-build;report.searchIndexBytes=await owner.client`select relname,pg_relation_size(oid)::text as bytes from pg_class where relname=any(${names}::text[])order by relname`;
  await owner.client`analyze person`;await owner.client`analyze employment`;probe=await installPersonnelSearchProbe(true);
  const modes:{name:string;q:string;total:number;hits:number;ids?:string[]}[]=[
   {name:'selective-code',q:'PERF'+String(count).padStart(9,'0'),total:1,hits:1,ids:[lastId]},
   {name:'selective-name',q:person.name,total:1,hits:1,ids:[lastId]},
   {name:'selective-email',q:person.email,total:1,hits:1,ids:[lastId]},
   {name:'exactly25',q:'LIMIT25-',total:25,hits:25,ids:expected.first},
   {name:'broad-code-fallback',q:'PERF',total:count-25,hits:26},
   {name:'broad-name-fallback',q:'Fictional retained Personnel',total:count,hits:26,ids:expected.first},
  ];
  const searchMeasurements:{mode:string;phase:string;elapsedMs:number;total:number;pageRows:number;rawHits:number|null;usedBounded:boolean;usedSampleOverflow:boolean;exactDto:boolean}[]=[];
  const plans:unknown[]=[];
  for(const mode of modes){
   const filters={companyIds:companies,q:mode.q},page={...filters,limit:25,offset:0};let oracle:unknown;
   for(const variant of ['original','candidate','candidate-warm','restored']){
    phase(mode.name+'-'+variant);const start=performance.now();
    const candidate=variant.startsWith('candidate')?await readWithPersonnelSearchProbe(ctx,page,filters,probe):null;
    const actual=candidate?.dto??await personnelListPage(ctx,page,filters),elapsedMs=performance.now()-start;
    if(!oracle)oracle=actual;
    expect(actual).toEqual(oracle);expect(actual.total).toBe(mode.total);expect(actual.headcount.total).toBe(mode.total);
    if(mode.ids)expect(actual.rows.map(row=>row.employmentId)).toEqual(mode.ids);
    expect(actual.rows.every(row=>row.companyId===b.companyId)).toBe(true);
    if(candidate){expect(candidate.rawHits).toBe(mode.hits);expect(candidate.usedBounded).toBe(mode.hits<=25);expect(candidate.usedSampleOverflow).toBe(mode.hits>25);}
    searchMeasurements.push({mode:mode.name,phase:variant,elapsedMs,total:actual.total,pageRows:actual.rows.length,rawHits:candidate?.rawHits??null,usedBounded:candidate?.usedBounded??false,usedSampleOverflow:candidate?.usedSampleOverflow??false,exactDto:true});
    report.searchMeasurements=searchMeasurements;save();
   }
   if(mode.hits<=25){
    const observed=await readWithPersonnelSearchProbe(ctx,page,filters,probe,undefined,true);expect(observed.dto).toEqual(oracle);
    const scans:Record<string,unknown>[]=[];
    const visit=(value:unknown)=>{if(Array.isArray(value))for(const nested of value)visit(nested);else if(value&&typeof value==='object'){const row=value as Record<string,unknown>;if(row['Function Name']==='access_workforce_list_facts')scans.push(row);for(const nested of Object.values(row))visit(nested);}};
    visit(observed.plans?.page);expect(scans.length).toBeGreaterThan(0);expect(scans.every(scan=>Number(scan['Actual Loops'])===0)).toBe(true);
    plans.push({mode:mode.name,fullFactsLoops:0,plans:observed.plans});report.searchPlans=plans;save();
   }
  }
  const searchComparisons=modes.map(mode=>{
   const rows=searchMeasurements.filter(row=>row.mode===mode.name),maxCandidate=Math.max(rows[1].elapsedMs,rows[2].elapsedMs),ratio=maxCandidate/Math.min(rows[0].elapsedMs,rows[3].elapsedMs);
   const bounded=mode.hits<=25;return{mode:mode.name,bounded,maxCandidateMs:maxCandidate,ratio,targetMet:bounded?maxCandidate<1000&&ratio<.8:ratio<=1.1};
  });
  report.searchComparisons=searchComparisons;
  const searchQualified=searchComparisons.every(row=>row.targetMet);
  report.qualification={searchComponentQualified:searchQualified,unchangedInitialTargetMet:false,unchangedDeepTargetMet:false,
   wholePersonnelNativeTargetMet:false,limitations:'Search-only. Initial/deep unqualified in the retained exact predecessor; no browser or 500-user acceptance.'};
  phase('all-search-queries-measured');
  expect(searchQualified,'Each indexed narrow search under1000ms and >=20% faster; every exact broad fallback <=10% regression against fresh same-run controls').toBe(true);
  phase('complete');
 }catch(error){report.errorType=(error as Error).name;phase('failed');throw error;}
 finally{
  for(const name of [...indexes].reverse())await owner.client.unsafe('drop index if exists public.'+name);
  if(probe)await probe.drop();if(extensionCreated)await owner.client`drop extension pg_trgm`;
  if(originalFunctions)expect(Array.from(await functions())).toEqual(originalFunctions);
  report.searchPrototypeObjectsRemoved=true;report.originalNativeFunctionsUnchanged=true;
  for(const trigger of triggers){
   for(const event of ['insert','update','delete'])await owner.client.unsafe('DROP TRIGGER IF EXISTS performance_fixture_reminder_'+event+' ON public.'+trigger.name);
   await owner.client.unsafe('DROP TRIGGER IF EXISTS assessment_reminder_touch ON public.'+trigger.name);await owner.client.unsafe(trigger.ddl);
   const [restored]=await owner.client`select pg_get_triggerdef(oid)as ddl from pg_trigger where tgrelid=${'public.'+trigger.name}::regclass and tgname='assessment_reminder_touch'`;
   expect(restored.ddl).toBe(trigger.ddl);
  }
  await owner.client.unsafe('DROP FUNCTION IF EXISTS app.performance_fixture_reminder_batch()');
  report.fixtureTriggersRestored=triggers.length===2;save();
 }
},3000000);
