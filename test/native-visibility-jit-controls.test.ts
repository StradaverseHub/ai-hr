/** Hosted disposable-DB attribution only: no production settings, policy or function changes. */
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {cpus,totalmem} from 'node:os';
import {join} from 'node:path';
import {eq,inArray,sql,type SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {appUser,assignment,company,employment,person,reportingLine,roleAssignment} from '../db/schema';
import {assertAiPresentationPrincipalTx} from '../core/ai-principal';
import {readEmployeeChoices} from '../core/employee-choice';
import {addCalendarMonths,todayInKualaLumpur} from '../lib/hr-date';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner} from './harness';
import {workerDb} from './db-names';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';
import {capturePostgresEvidence,postgresProfileFromEnv,validatePostgresEvidence} from '../.github/ci/postgres-evidence.mjs';
const file='test/native-visibility-jit-controls.test.ts';
const selected:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selected)&&selected.length===1&&selected[0]===file;
beforeAll(migrateTestDb);
// pg_get_expr's exact reviewed 0691 predecessor, including both positive CASE arms.
// An exact whole-expression guard excludes NOT/negative membership and altered tenant guards.
const compact=(value:string)=>value.replace(/\s+/g,'');
const oldMembership='(id=ANY((SELECTapp.visible_employment_ids()ASvisible_employment_ids)::uuid[]))';
const expectedQual="((voided_atISNULL)AND(tenant_id=app.current_tenant_id())ANDCASEWHEN((SELECTcurrent_setting('app.bank_import_point_read'::text,true)AScurrent_setting)='on'::text)THENCASEWHENapp.is_admin_for(company_id)THENtrueELSE((voided_atISNULL)AND((tenant_id=app.current_tenant_id())AND((id=ANY((SELECTapp.visible_employment_ids()ASvisible_employment_ids)::uuid[]))ORapp.can_admin_payroll_for(company_id)ORapp.can_admin_perfcomp_for(company_id))))ENDELSE((voided_atISNULL)AND((tenant_id=app.current_tenant_id())AND((id=ANY((SELECTapp.visible_employment_ids()ASvisible_employment_ids)::uuid[]))ORapp.can_admin_payroll_for(company_id)ORapp.can_admin_perfcomp_for(company_id))))END)";
const expectedCheck='((tenant_id=app.current_tenant_id())ANDapp.is_admin_for(company_id))';
async function policies(){
 return Array.from(await owner.client`select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check
  from pg_policies where schemaname in ('public','app') order by schemaname,tablename,policyname`);
}
async function visibilityDefinition(){
 const [row]=await owner.client`select p.prosrc as body,md5(p.prosrc) as body_md5,pg_get_functiondef(p.oid) as definition,
  p.proowner::regrole::text as owner,p.proacl::text as acl,p.proconfig as settings,l.lanname as language,
  p.prosecdef as definer,p.provolatile as volatility,p.proparallel as parallel,p.proisstrict as strict,
  p.proleakproof as leakproof,p.prokind as kind,p.proretset as set_returning,p.prorettype::regtype::text as return_type,
  p.proargtypes::text as argument_types,p.procost as cost,p.prorows as rows
  from pg_proc p join pg_language l on l.oid=p.prolang where p.oid='app.visible_employment_ids()'::regprocedure`;
 return row;
}
type Page=Awaited<ReturnType<typeof readEmployeeChoices>>;
const stablePage=({contextId:_contextId,...page}:Page)=>page;

async function functionDefinitions(){
 return Array.from(await owner.client`select p.oid::regprocedure::text as signature,p.prosrc as body,md5(p.prosrc) as body_md5,
  pg_get_functiondef(p.oid) as definition,p.proowner::regrole::text as owner,p.proacl::text as acl,p.proconfig as settings,
  l.lanname as language,p.prosecdef as definer,p.provolatile as volatility,p.proparallel as parallel,p.proisstrict as strict,
  p.proleakproof as leakproof,p.prokind as kind,p.proretset as set_returning,p.prorettype::regtype::text as return_type,
  p.proargtypes::text as argument_types,p.procost as cost,p.prorows as rows
  from pg_proc p join pg_language l on l.oid=p.prolang where p.oid in
   ('app.visible_employment_ids()'::regprocedure,'app.visible_person_ids()'::regprocedure,
    'app.can_see_employment(uuid)'::regprocedure,'app.can_see_person(uuid)'::regprocedure)
  order by p.oid::regprocedure::text`);
}
type PlanDocument={Plan:Record<string,unknown>;'Execution Time':number;'Planning Time':number;JIT?:unknown};
const document=(rows:unknown)=>((rows as {'QUERY PLAN':PlanDocument[]}[])[0]['QUERY PLAN'][0]);

const variants=[
 {name:'any_jit_on',policy:'any',jit:'on'},
 {name:'any_jit_off',policy:'any',jit:'off'},
 {name:'direct_in_jit_on',policy:'direct',jit:'on'},
 {name:'direct_in_jit_off',policy:'direct',jit:'off'},
 {name:'initplan_in_jit_on',policy:'initplan',jit:'on'},
] as const;
type Variant=typeof variants[number];
let probe:Awaited<ReturnType<typeof prepare>>|undefined;

async function prepare(){
 expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');expect(process.env.AIHR_FOCUSED_EVIDENCE_DIR).toBeTruthy();
 const poolId=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;expect(poolId).toBeTruthy();expect(process.env.WORKER_DB).not.toBe('0');
 for(const key of ['TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']){
  const target=new URL(process.env[key]!);expect(target.hostname).toBe('127.0.0.1');expect(target.pathname).toBe('/'+workerDb(poolId!));
 }
 const report:Record<string,unknown>={kind:'DISPOSABLE_NATIVE_JIT_AND_INITPLAN_ATTRIBUTION',releaseEligible:false,employees:50000,
  testCaseBudgetMs:300000,statementTimeoutMs:20000,lockTimeoutMs:300,
  host:{cpuModels:[...new Set(cpus().map(cpu=>cpu.model))],logicalCpus:cpus().length,ramBytes:totalmem()},
  variants,limitations:'Per-case300s budget retained. Transaction-local JIT is an experiment, not an installation setting. Whole-container peaks are cumulative, not per-query peak allocations.'};
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'native-visibility-jit-controls.json'),JSON.stringify(report,null,2));
 const fixture=await seedPersonnelNativeFixture(50000,report,phase=>{report.phase=phase;save();},save);
 const originals=await policies(),originalFunctions=await functionDefinitions(),originalFunction=await visibilityDefinition();
 const original=originals.find(row=>row.schemaname==='public'&&row.tablename==='employment'&&row.policyname==='employment_rls');
 expect(original).toMatchObject({permissive:'PERMISSIVE',roles:['ai_hr_app'],cmd:'ALL'});
 expect(compact(original!.qual!)).toBe(expectedQual);expect(compact(original!.with_check!)).toBe(expectedCheck);
 expect(expectedQual.split(oldMembership)).toHaveLength(3);
 expect(originalFunction).toMatchObject({body_md5:'1bc7e85a740a98b9db79efb2b7768c8b',language:'plpgsql',definer:true,volatility:'s',settings:['search_path=public']});
 expect(originalFunctions.find(row=>row.signature==='app.visible_person_ids()')).toMatchObject({body_md5:'069349991a58334a042b7fb6200bee08'});
 const [constraint]=await owner.client`select contype,condeferrable,condeferred,convalidated,pg_get_constraintdef(oid) as definition
  from pg_constraint where conrelid='public.assignment'::regclass and conname='assignment_no_overlap'`;
 expect(constraint).toMatchObject({contype:'x',condeferrable:false,condeferred:false,convalidated:true});
 report.assignmentCardinalityPrerequisite=constraint;report.originalEmploymentPolicy=original;report.originalFunctions=originalFunctions;
 const pattern=/\(id\s*=\s*ANY\s*\(\(\s*SELECT\s+app\.visible_employment_ids\(\)\s+AS\s+visible_employment_ids\s*\)::uuid\[\]\)\)/g;
 expect(original!.qual!.match(pattern)).toHaveLength(2);
 const replacements={any:'',direct:'(id IN (SELECT unnest(app.visible_employment_ids())))',initplan:'(id IN (SELECT unnest((SELECT app.visible_employment_ids()))))'};
 const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('application_name','native_jit_and_initplan_probe');
 const single=database.createDb(url.toString(),{max:1});expect(single.client.options.max).toBe(1);
 const [session]=await single.client`select pg_backend_pid() as pid,current_setting('jit') as jit,current_setting('work_mem') as work_mem,current_setting('hash_mem_multiplier') as hash_mem_multiplier,
  current_setting('statement_timeout') as statement_timeout,current_setting('lock_timeout') as lock_timeout`;
 const {pid,...defaults}=session;expect(Number.isSafeInteger(pid)&&pid>0).toBe(true);
 expect(defaults.jit).toBe('on');report.sessionDefaults=defaults;
 const dialect=new PgDialect(),pids=new Set<number>([pid]),identities:unknown[]=[],statements:Record<string,unknown>[]=[],plans:Record<string,unknown>[]=[],memoryRequests:unknown[]=[];
 report.identities=identities;report.statements=statements;report.plans=plans;report.memoryRequests=memoryRequests;
 let variant:Variant=variants[0],capture=false,firstSample=false,queries:SQL[]=[];
 const resetSettings=async()=>{
  const [after]=await single.client`select current_setting('jit') as jit,current_setting('work_mem') as work_mem,current_setting('hash_mem_multiplier') as hash_mem_multiplier,
   current_setting('statement_timeout') as statement_timeout,current_setting('lock_timeout') as lock_timeout`;
  expect(after).toEqual(defaults);
 };
 const restore=async()=>{
  await owner.client.begin(async tx=>{await tx`set local lock_timeout='300ms'`;await tx`set local statement_timeout='20s'`;await tx.unsafe('alter policy employment_rls on public.employment using ('+original!.qual+')');});
  expect(await policies()).toEqual(originals);expect(await functionDefinitions()).toEqual(originalFunctions);await resetSettings();
  report.originalPoliciesFunctionsAndSessionSettingsRestored=true;save();
 };
 const choose=async(next:Variant)=>{
  variant=next;queries=[];
  // Identical-policy ALTER also invalidates cached plans for the JIT-only controls.
  // Every variant gets a fresh policy plan; no plan_cache_mode or cost tuning is used.
  const qual=next.policy==='any'?original!.qual!:original!.qual!.replace(pattern,replacements[next.policy]);
  await owner.client.begin(async tx=>{await tx`set local lock_timeout='300ms'`;await tx`set local statement_timeout='20s'`;await tx.unsafe('alter policy employment_rls on public.employment using ('+qual+')');});
  const current=await policies(),target=current.find(row=>row.schemaname==='public'&&row.tablename==='employment'&&row.policyname==='employment_rls');
  expect(current.map(row=>row===target?{...row,qual:original!.qual}:row)).toEqual(originals);
  let reviewed=compact(target!.qual!);
  if(next.policy!=='any'){
   const expression=next.policy==='direct'?'(idIN(SELECTunnest(app.visible_employment_ids())ASunnest))':'(idIN(SELECTunnest((SELECTapp.visible_employment_ids()ASvisible_employment_ids))ASunnest))';
   expect(reviewed.split(expression)).toHaveLength(3);reviewed=reviewed.replaceAll(expression,oldMembership);
  }
  expect(reviewed).toBe(expectedQual);expect(await functionDefinitions()).toEqual(originalFunctions);await resetSettings();
  report.phase=next.name;save();
 };
 const install=()=>vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>
  single.withTenant(context,async tx=>{
   await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='20s'`);
   await tx.execute(sql`select set_config('jit',${variant.jit},true)`);
   const [identity]=await tx.execute<{role:string;pid:number;tenant:string;user:string;employment_rls:boolean;person_rls:boolean;assignment_rls:boolean;read_only:string;isolation:string;jit:string;work_mem:string;hash_mem_multiplier:string;statement_timeout:string;lock_timeout:string}>(sql`
    select current_user as role,pg_backend_pid() as pid,app.current_tenant_id() as tenant,app.current_user_id() as "user",
     row_security_active('public.employment'::regclass) as employment_rls,row_security_active('public.person'::regclass) as person_rls,row_security_active('public.assignment'::regclass) as assignment_rls,
     current_setting('transaction_read_only') as read_only,current_setting('transaction_isolation') as isolation,current_setting('jit') as jit,
     current_setting('work_mem') as work_mem,current_setting('hash_mem_multiplier') as hash_mem_multiplier,current_setting('statement_timeout') as statement_timeout,current_setting('lock_timeout') as lock_timeout`);
   expect(identity).toMatchObject({role:'ai_hr_app',tenant:context.tenantId,user:context.userId,employment_rls:true,person_rls:true,assignment_rls:true,
    read_only:'on',isolation:'repeatable read',jit:variant.jit,work_mem:defaults.work_mem,hash_mem_multiplier:defaults.hash_mem_multiplier,statement_timeout:'20s',lock_timeout:'300ms'});
   pids.add(identity.pid);identities.push({variant:variant.name,...identity});
   return read(new Proxy(tx,{get(target,key,receiver){
    if(key==='execute'&&capture)return async(query:SQL)=>{
     const text=dialect.sqlToQuery(query).sql,entry:Record<string,unknown>={variant:variant.name,sql:text},started=performance.now();statements.push(entry);
     if(firstSample&&!text.includes('select exists(select 1 from public.app_user u'))queries.push(query);
     try{return await target.execute(query);}finally{entry.ms=performance.now()-started;save();}
    };
    const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
   }}));
  },options));
 const resources=()=>{
  const profile=postgresProfileFromEnv(process.env),evidence=capturePostgresEvidence('db-1',profile);validatePostgresEvidence(evidence,{postgres:profile});
  const cpuText=execFileSync('docker',['exec',evidence.name,'cat','/sys/fs/cgroup/cpu.stat'],{encoding:'utf8',timeout:10000,maxBuffer:65536});
  const cpu=Object.fromEntries(cpuText.trim().split('\n').map(line=>{const [key,value]=line.split(/\s+/);return [key,Number(value)];}));
  const pid=[...pids][0];let backendMemory:Record<string,number>={};
  if(pid){
   expect(Number.isSafeInteger(pid)&&pid>0).toBe(true);
   const status=execFileSync('docker',['exec',evidence.name,'cat','/proc/'+pid+'/status'],{encoding:'utf8',timeout:10000,maxBuffer:65536});
   backendMemory=Object.fromEntries([...status.matchAll(/^(VmRSS|VmHWM):\s+(\d+)\s+kB$/gm)].map(match=>[match[1]+'Bytes',Number(match[2])*1024]));
  }
  return {evidence,cpu,backendMemory,capturedAt:new Date().toISOString(),interpretation:'Container CPU counters and cumulative cgroup/backend high-water memory; telemetry is outside timed port samples.'};
 };
 const explain=async(tx:Tx,query:SQL,purpose:string)=>{
  const compiled=dialect.sqlToQuery(query),started=performance.now();let active=true;
  const sampling=purpose==='page'?(async()=>{
   for(const delay of [150,250]){
    await new Promise(resolve=>setTimeout(resolve,delay));if(!active)break;
    const [request]=await owner.client`select pg_log_backend_memory_contexts(${[...pids][0]}::integer) as requested`;
    expect(request.requested).toBe(true);memoryRequests.push({variant:variant.name,purpose,pid:[...pids][0],at:new Date().toISOString(),sampleOnly:true});save();
   }
  })():Promise.resolve();
  let plan:unknown,sqlWallMs=0;
  try{plan=Array.from(await tx.execute(sql`explain(analyze,buffers,format json) ${query}`));}
  finally{sqlWallMs=performance.now()-started;active=false;await sampling;}
  const doc=document(plan);
  if(variant.jit==='off')expect(doc['JIT']).toBeUndefined();
  const entry={variant:variant.name,purpose,sql:compiled.sql,parameters:compiled.params,plan,wallMs:sqlWallMs,
   planningMs:doc['Planning Time'],executionMs:doc['Execution Time'],jit:doc['JIT']??null};plans.push(entry);save();return doc;
 };
 return {fixture,report,save,single,pids,install,choose,restore,resetSettings,resources,explain,
  beginCapture:(first:boolean)=>{capture=true;firstSample=first;},endCapture:()=>{capture=false;firstSample=false;},captured:()=>queries};
}

afterAll(async()=>{try{if(probe)await probe.restore();}finally{try{if(probe)await probe.single.client.end({timeout:5});}finally{await closeAll();}}});

it.skipIf(!requested)('attributes five same-backend full-port/planning/JIT variants without changing installation settings',async()=>{
 probe=await prepare();const p=probe,spy=p.install();
 const timings:Record<string,number[]>={},resourcePhases:unknown[]=[];p.report.timings=timings;p.report.resourcePhases=resourcePhases;
 let baseline:ReturnType<typeof stablePage>|undefined;
 try{
  const a='00000000-0000-0000-0000-000000000001',z='00000000-0000-0000-0000-000000000002';
  const truth=await owner.client`with cases(label,id,ids,expected) as(values
   ('null-array',${a}::uuid,null::uuid[],false),('empty-array',${a}::uuid,array[]::uuid[],false),
   ('null-element',${a}::uuid,array[null::uuid],false),('null-id',null::uuid,array[${a}::uuid],false),
   ('match',${a}::uuid,array[${a}::uuid],true),('missing',${z}::uuid,array[${a}::uuid],false),
   ('duplicates',${a}::uuid,array[${a}::uuid,${a}::uuid],true),('match-null',${a}::uuid,array[null::uuid,${a}::uuid],true),
   ('missing-null',${z}::uuid,array[null::uuid,${a}::uuid],false))
   select label,(id=any(ids))is true as old_allowed,(id in(select unnest(ids)))is true as direct_allowed,
    (id in(select unnest((select ids))))is true as initplan_allowed,expected from cases order by label`;
  for(const row of truth){expect(row.old_allowed).toBe(row.expected);expect(row.direct_allowed).toBe(row.expected);expect(row.initplan_allowed).toBe(row.expected);}
  p.report.positiveRlsTruthTable=truth;p.save();
  for(const variant of variants){
   await p.choose(variant);const before=p.resources();timings[variant.name]=[];
   for(let repeat=0;repeat<2;repeat++){
    p.beginCapture(repeat===0);const started=performance.now();let page:Page;
    try{page=await readEmployeeChoices(p.fixture.ctx,{companyIds:[p.fixture.b.companyId],selectedId:p.fixture.expectedLast.at(-1)});}
    finally{p.endCapture();}
    timings[variant.name].push(performance.now()-started);
    expect(page.total).toBe(50000);expect(page.rows).toHaveLength(25);expect(page.rows.map(row=>row.employmentId)).toEqual(p.fixture.expectedFirst);expect(page.selected?.employmentId).toBe(p.fixture.expectedLast.at(-1));
    if(baseline)expect(stablePage(page)).toEqual(baseline);else baseline=stablePage(page);p.save();
   }
   const after=p.resources();resourcePhases.push({variant:variant.name,before,after,cpuUsageUsec:after.cpu.usage_usec-before.cpu.usage_usec});p.save();
   expect(p.captured()).toHaveLength(5);
   await database.withTenant(p.fixture.ctx,async tx=>{
    await assertAiPresentationPrincipalTx(tx,p.fixture.ctx);
    for(const [index,query]of p.captured().entries()){
     const doc=await p.explain(tx,query,['page','selected','company-options','department-options','unit-options'][index]);
     expect(doc.Plan['Actual Rows']).toBe(index===0?25:index===1?1:index===4?0:1);
    }
    const started=performance.now(),[points]=await tx.execute<{own:boolean;foreign:boolean;unknown:boolean}>(sql`
     select app.can_see_employment(${p.fixture.expectedLast.at(-1)!}::uuid) as own,app.can_see_employment(${p.fixture.foreignEmployment}::uuid) as "foreign",app.can_see_employment(${randomUUID()}::uuid) as "unknown"`);
    expect(points).toEqual({own:true,foreign:false,unknown:false});
    const scalar=(p.report.scalarPoints??=[])as unknown[];scalar.push({variant:variant.name,ms:performance.now()-started,result:points});
   },{readOnlySnapshot:true});
   await p.resetSettings();
  }
  expect(p.pids.size).toBe(1);p.report.performanceStageComplete=true;p.report.samePhysicalAppBackend=true;p.report.appPoolMax=1;p.save();
 }finally{p.endCapture();spy.mockRestore();await p.restore();}
},300000);

async function prepareAuthority(p:NonNullable<typeof probe>){
 const {b,ctx,foreign,foreignEmployment,expectedFirst}=p.fixture,ids=expectedFirst.slice(0,2);
 const people=await owner.db.select({id:employment.id,personId:employment.personId}).from(employment).where(inArray(employment.id,ids));
 const personFor=(id:string)=>people.find(row=>row.id===id)!.personId;
 const employeeUser=await createAppUser(b.tenantId,personFor(ids[0]),'employee'),managerUser=await createAppUser(b.tenantId,personFor(ids[1]),'manager');
 const [edge]=await owner.db.insert(reportingLine).values({tenantId:b.tenantId,subordinateEmploymentId:ids[0],managerEmploymentId:ids[1],lineType:'administrative',validFrom:'2020-01-01'}).returning({id:reportingLine.id});
 const employeeCtx:SessionContext={tenantId:b.tenantId,userId:employeeUser,personId:personFor(ids[0]),roles:['employee']},managerCtx:SessionContext={tenantId:b.tenantId,userId:managerUser,personId:personFor(ids[1]),roles:['manager']};
 const otherCompany=randomUUID(),otherPerson=randomUUID(),otherEmployment=randomUUID();
 await owner.db.insert(company).values({id:otherCompany,tenantId:b.tenantId,legalName:'Fictional isolated membership company'});
 await owner.db.insert(person).values({id:otherPerson,tenantId:b.tenantId,fullName:'Fictional dated-company membership employee',primaryEmail:otherPerson+'@example.invalid'});
 await owner.db.insert(employment).values({id:otherEmployment,tenantId:b.tenantId,personId:otherPerson,companyId:otherCompany,hiredOn:'2020-01-01'});
 // Historical assignment company differs from CURRENT employment company. Membership
 // must continue to use employment visibility, never assignment.company_id as a shortcut.
 await owner.db.insert(assignment).values({tenantId:b.tenantId,employmentId:otherEmployment,companyId:b.companyId,departmentId:b.deptB,validFrom:'2020-01-01',employmentType:'full_time'});
 const selfUser=await createAppUser(b.tenantId,otherPerson,'employee'),scopedUser=await createAppUser(b.tenantId,null,'hr_admin');
 await owner.db.update(roleAssignment).set({companyId:b.companyId}).where(eq(roleAssignment.appUserId,scopedUser));
 const selfCtx:SessionContext={tenantId:b.tenantId,userId:selfUser,personId:otherPerson,roles:['employee']},scopedCtx:SessionContext={tenantId:b.tenantId,userId:scopedUser,grants:[{role:'hr_admin',companyId:b.companyId}]};
 const partnerContexts:SessionContext[]=[];
 for(const role of ['payroll_partner','performance_comp_partner']as const){
  const user=await createAppUser(b.tenantId,null,'hr_admin');await owner.db.update(roleAssignment).set({role,companyId:otherCompany}).where(eq(roleAssignment.appUserId,user));
  partnerContexts.push({tenantId:b.tenantId,userId:user,grants:[{role,companyId:otherCompany}]});
 }
 const results:Record<string,unknown>={};p.report.authorityResults=results;
 const assertBaseline=async()=>{
  const [actual]=await owner.client`select
   (select department_id from assignment where employment_id=${ids[1]}::uuid and valid_to is null and superseded_at is null) as manager_department,
   (select valid_from::text from reporting_line where id=${edge.id}::uuid) as edge_valid_from,
   (select archived_at from app_user where id=${employeeUser}::uuid) as employee_archived,
   (select voided_at from employment where id=${otherEmployment}::uuid) as employment_voided,
   (select voided_at from person where id=${otherPerson}::uuid) as person_voided,
   (select count(*)::int from role_assignment where app_user_id=${employeeUser}::uuid and role='employee' and company_id is null) as employee_grants`;
  expect(actual).toEqual({manager_department:b.deptA,edge_valid_from:'2020-01-01',employee_archived:null,employment_voided:null,person_voided:null,employee_grants:1});
 };
 await assertBaseline();
 return {b,ctx,foreign,foreignEmployment,expectedFirst,ids,employeeUser,managerUser,edge,employeeCtx,managerCtx,
  otherCompany,otherPerson,otherEmployment,selfCtx,scopedCtx,partnerContexts,results,assertBaseline};
}
let authorityFixture:Awaited<ReturnType<typeof prepareAuthority>>|undefined;

it.skipIf(!requested).each(variants)('preserves every native authority control for $name',async(variant)=>{
 expect(probe,'Performance stage must establish the controlled fixture and backend').toBeTruthy();const p=probe!;
 authorityFixture??=await prepareAuthority(p);
 const {b,ctx,foreign,foreignEmployment,expectedFirst,ids,employeeUser,edge,employeeCtx,managerCtx,
  otherCompany,otherPerson,otherEmployment,selfCtx,scopedCtx,partnerContexts,results,assertBaseline}=authorityFixture;
 await assertBaseline();const spy=p.install(),started=performance.now();
 try{
   await p.choose(variant);
   await owner.db.update(assignment).set({departmentId:b.deptB}).where(eq(assignment.employmentId,ids[1]));
   const employee=await readEmployeeChoices(employeeCtx,{companyIds:[],selectedId:ids[1]});expect(employee.total).toBe(1);expect(employee.rows.map(row=>row.employmentId)).toEqual([ids[0]]);expect(employee.selected).toBeNull();
   const manager=await readEmployeeChoices(managerCtx,{companyIds:[b.companyId],selectedId:ids[0]});expect(manager.total).toBe(2);expect(manager.rows.map(row=>row.employmentId)).toEqual(ids);
   // A deptB manager can also see the historical deptB row outside company b.
   // Trusted server scope b retains the independently known manager and HOD counts.
   await owner.db.update(assignment).set({departmentId:b.deptA}).where(eq(assignment.employmentId,ids[1]));
   let hod:Page;
   try{hod=await readEmployeeChoices(managerCtx,{companyIds:[b.companyId],selectedId:otherEmployment});expect(hod.total).toBe(50000);expect(hod.rows.map(row=>row.employmentId)).toEqual(expectedFirst);expect(hod.selected).toBeNull();}
   finally{await owner.db.update(assignment).set({departmentId:b.deptB}).where(eq(assignment.employmentId,ids[1]));}
   await owner.db.update(reportingLine).set({validFrom:addCalendarMonths(todayInKualaLumpur(),1)}).where(eq(reportingLine.id,edge.id));
   let future:Page;
   try{future=await readEmployeeChoices(managerCtx,{companyIds:[b.companyId],selectedId:ids[0]});expect(future.total).toBe(1);expect(future.rows.map(row=>row.employmentId)).toEqual([ids[1]]);expect(future.selected).toBeNull();}
   finally{await owner.db.update(reportingLine).set({validFrom:'2020-01-01'}).where(eq(reportingLine.id,edge.id));}
   const transferred=await readEmployeeChoices(selfCtx,{companyIds:[otherCompany],selectedId:otherEmployment});expect(transferred.total).toBe(1);expect(transferred.rows[0].employmentId).toBe(otherEmployment);expect(transferred.rows[0].departmentId).toBe(b.deptB);
   const deniedCompany=await readEmployeeChoices(scopedCtx,{companyIds:[otherCompany],selectedId:otherEmployment});expect(deniedCompany.total).toBe(0);expect(deniedCompany.rows).toEqual([]);expect(deniedCompany.selected).toBeNull();expect(deniedCompany.companyOptions).toEqual([]);
   const deniedTenant=await readEmployeeChoices({...adminCtx(foreign),grants:[{role:'hr_admin',companyId:null}]},{companyIds:[b.companyId],selectedId:ids[0]});expect(deniedTenant.total).toBe(0);expect(deniedTenant.rows).toEqual([]);expect(deniedTenant.selected).toBeNull();
   const partnerPages:unknown[]=[];
   for(const partner of partnerContexts){
    const page=await readEmployeeChoices(partner,{companyIds:[otherCompany],selectedId:otherEmployment});expect(page.total).toBe(1);expect(page.rows.map(row=>row.employmentId)).toEqual([otherEmployment]);expect(page.selected?.employmentId).toBe(otherEmployment);
    const denied=await readEmployeeChoices(partner,{companyIds:[b.companyId],selectedId:ids[0]});expect(denied.total).toBe(0);expect(denied.selected).toBeNull();partnerPages.push({page:stablePage(page),denied:stablePage(denied)});
   }
   // Owner-only fictional row-state fixtures exercise the unchanged void guards;
   // this is not evidence for an import/revert writer or a production data repair.
   let voidedEmployment:Page,voidedPerson:Page;
   await owner.db.update(employment).set({voidedAt:new Date(),voidedBy:b.adminUserId,voidReason:'Fictional membership policy fixture',voidedImportAttemptId:randomUUID()}).where(eq(employment.id,otherEmployment));
   try{voidedEmployment=await readEmployeeChoices(partnerContexts[0],{companyIds:[otherCompany],selectedId:otherEmployment});expect(voidedEmployment.total).toBe(0);expect(voidedEmployment.rows).toEqual([]);expect(voidedEmployment.selected).toBeNull();}
   finally{await owner.db.update(employment).set({voidedAt:null,voidedBy:null,voidReason:null,voidedImportAttemptId:null}).where(eq(employment.id,otherEmployment));}
   await owner.db.update(person).set({voidedAt:new Date()}).where(eq(person.id,otherPerson));
   try{voidedPerson=await readEmployeeChoices(partnerContexts[0],{companyIds:[otherCompany],selectedId:otherEmployment});expect(voidedPerson.total).toBe(0);expect(voidedPerson.rows).toEqual([]);expect(voidedPerson.selected).toBeNull();}
   finally{await owner.db.update(person).set({voidedAt:null}).where(eq(person.id,otherPerson));}
   await owner.db.update(appUser).set({archivedAt:new Date()}).where(eq(appUser.id,employeeUser));
   try{await expect(readEmployeeChoices(employeeCtx,{companyIds:[]})).rejects.toThrow('calling authority');}
   finally{await owner.db.update(appUser).set({archivedAt:null}).where(eq(appUser.id,employeeUser));}
   const revoked=await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,employeeUser)).returning();expect(revoked).toHaveLength(1);
   try{await expect(readEmployeeChoices(employeeCtx,{companyIds:[],selectedId:ids[0]})).rejects.toThrow('calling authority');}
   finally{await owner.db.insert(roleAssignment).values(revoked);}
   const restored=await readEmployeeChoices(employeeCtx,{companyIds:[],selectedId:ids[0]});expect(restored.total).toBe(1);expect(restored.selected?.employmentId).toBe(ids[0]);
   const deniedSelection=await readEmployeeChoices(employeeCtx,{companyIds:[],selectedId:foreignEmployment});expect(deniedSelection.selected).toBeNull();
   await expect(readEmployeeChoices({...ctx,personId:randomUUID()},{companyIds:[b.companyId]})).rejects.toThrow('calling authority');
   const observed={employee:stablePage(employee),manager:stablePage(manager),hod:stablePage(hod!),future:stablePage(future!),transferred:stablePage(transferred),deniedCompany:stablePage(deniedCompany),deniedTenant:stablePage(deniedTenant),partnerPages,voidedEmployment:stablePage(voidedEmployment!),voidedPerson:stablePage(voidedPerson!),restored:stablePage(restored)};
   if(results.any_jit_on)expect(observed).toEqual(results.any_jit_on);results[variant.name]=observed;await p.resetSettings();p.save();
  expect(p.pids.size).toBe(1);
  const caseTimings=(p.report.authorityCaseMs??={})as Record<string,number>;caseTimings[variant.name]=performance.now()-started;
  p.report.authorityStageComplete=variants.every(item=>Object.hasOwn(results,item.name));
  if(p.report.authorityStageComplete)p.report.phase='complete';p.save();
 }finally{
  spy.mockRestore();
  try{await owner.db.update(assignment).set({departmentId:b.deptA}).where(eq(assignment.employmentId,ids[1]));await assertBaseline();}
  finally{await p.restore();}
 }
},300000);
