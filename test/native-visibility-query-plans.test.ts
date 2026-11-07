/** Hosted read-only query attribution; employment-only policy experiment, no production changes. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {cpus,totalmem} from 'node:os';
import {join} from 'node:path';
import {eq,inArray,sql,type SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {employment,reportingLine,roleAssignment} from '../db/schema';
import {assertAiPresentationPrincipalTx} from '../core/ai-principal';
import {readEmployeeChoices} from '../core/employee-choice';
import {closeAll,createAppUser,migrateTestDb,owner} from './harness';
import {workerDb} from './db-names';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';
const file='test/native-visibility-query-plans.test.ts';
const selected:unknown=JSON.parse(process.env.AIHR_FOCUSED_TESTS??'[]');
const requested=process.env.GITHUB_ACTIONS==='true'&&Array.isArray(selected)&&selected.length===1&&selected[0]===file;
beforeAll(migrateTestDb);afterAll(closeAll);
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
type Mode='array_any'|'set_in';
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
type PlanDocument={Plan:Record<string,unknown>;'Execution Time':number};
const document=(rows:unknown)=>((rows as {'QUERY PLAN':PlanDocument[]}[])[0]['QUERY PLAN'][0]);

it.skipIf(!requested)('captures exact complete native choice plans and separates scalar and person-set costs',async()=>{
 expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');expect(process.env.AIHR_FOCUSED_EVIDENCE_DIR).toBeTruthy();
 const poolId=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;
 expect(poolId).toBeTruthy();expect(process.env.WORKER_DB).not.toBe('0');
 for(const key of ['TEST_DATABASE_URL','TEST_MIGRATION_DATABASE_URL']){
  const target=new URL(process.env[key]!);expect(target.hostname).toBe('127.0.0.1');expect(target.pathname).toBe('/'+workerDb(poolId!));
 }
 const report:Record<string,unknown>={kind:'DISPOSABLE_NATIVE_COMPLETE_QUERY_ATTRIBUTION',releaseEligible:false,employees:50000,
  statementTimeoutMs:20000,lockTimeoutMs:300,testBudgetMs:300000,
  host:{cpuModels:[...new Set(cpus().map(cpu=>cpu.model))],logicalCpus:cpus().length,ramBytes:totalmem()},
  limitations:'Exact canonical SQL plans and component attribution only. Existing policies and all visibility function definitions are restored/unchanged.'};
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'native-visibility-query-plans.json'),JSON.stringify(report,null,2));
 const fixture=await seedPersonnelNativeFixture(50000,report,phase=>{report.phase=phase;save();},save);
 const {b,ctx,foreignEmployment,expectedFirst,expectedLast}=fixture;
 const originals=await policies(),originalFunctions=await functionDefinitions(),originalFunction=await visibilityDefinition();
 const original=originals.find(row=>row.schemaname==='public'&&row.tablename==='employment'&&row.policyname==='employment_rls');
 expect(original).toMatchObject({permissive:'PERMISSIVE',roles:['ai_hr_app'],cmd:'ALL'});
 expect(compact(original!.qual!)).toBe(expectedQual);expect(compact(original!.with_check!)).toBe(expectedCheck);
 expect(expectedQual.split(oldMembership)).toHaveLength(3);
 expect(originalFunction).toMatchObject({body_md5:'1bc7e85a740a98b9db79efb2b7768c8b',language:'plpgsql',definer:true,volatility:'s',settings:['search_path=public']});
 const personFunction=originalFunctions.find(row=>row.signature==='app.visible_person_ids()');
 expect(personFunction).toMatchObject({body_md5:'069349991a58334a042b7fb6200bee08',language:'sql',definer:true,volatility:'s',settings:['search_path=public'],return_type:'uuid[]'});
 report.originalEmploymentPolicy=original;report.originalFunctions=originalFunctions;
 const pattern=/\(id\s*=\s*ANY\s*\(\(\s*SELECT\s+app\.visible_employment_ids\(\)\s+AS\s+visible_employment_ids\s*\)::uuid\[\]\)\)/g;
 expect(original!.qual!.match(pattern)).toHaveLength(2);
 const candidateQual=original!.qual!.replace(pattern,'(id IN (SELECT unnest(app.visible_employment_ids())))');
 const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('application_name','native_complete_query_probe');
 const single=database.createDb(url.toString(),{max:1});expect(single.client.options.max).toBe(1);
 const pids=new Set<number>(),identities:unknown[]=[],statements:Record<string,unknown>[]=[],planCaptures:Record<string,unknown>[]=[],components:Record<string,unknown>[]=[];
 const queries:Record<Mode,SQL[]>={array_any:[],set_in:[]},timings:Record<Mode,number[]>={array_any:[],set_in:[]};
 report.identities=identities;report.statements=statements;report.plans=planCaptures;report.components=components;report.timings=timings;
 let mode:Mode='array_any',capture=false,firstSample=false;
 const dialect=new PgDialect();
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>
  single.withTenant(context,async tx=>{
   await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='20s'`);
   const [identity]=await tx.execute<{role:string;pid:number;tenant:string;user:string;employment_rls:boolean;person_rls:boolean;assignment_rls:boolean;read_only:string;isolation:string}>(sql`
    select current_user as role,pg_backend_pid() as pid,app.current_tenant_id() as tenant,app.current_user_id() as "user",
     row_security_active('public.employment'::regclass) as employment_rls,row_security_active('public.person'::regclass) as person_rls,
     row_security_active('public.assignment'::regclass) as assignment_rls,current_setting('transaction_read_only') as read_only,current_setting('transaction_isolation') as isolation`);
   expect(identity).toMatchObject({role:'ai_hr_app',tenant:context.tenantId,user:context.userId,employment_rls:true,person_rls:true,assignment_rls:true,read_only:'on',isolation:'repeatable read'});
   pids.add(identity.pid);identities.push({mode,...identity});
   return read(new Proxy(tx,{get(target,key,receiver){
    if(key==='execute'&&capture)return async(query:SQL)=>{
     const text=dialect.sqlToQuery(query).sql,entry:Record<string,unknown>={mode,sql:text},started=performance.now();statements.push(entry);
     if(firstSample&&!text.includes('select exists(select 1 from public.app_user u'))queries[mode].push(query);
     try{return await target.execute(query);}finally{entry.ms=performance.now()-started;save();}
    };
    const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
   }}));
  },options));
 const setMode=async(next:Mode)=>{
  await owner.client.begin(async tx=>{
   await tx`set local lock_timeout='300ms'`;await tx`set local statement_timeout='20s'`;
   await tx.unsafe('alter policy employment_rls on public.employment using ('+(next==='array_any'?original!.qual:candidateQual)+')');
  });mode=next;
  const current=await policies(),target=current.find(row=>row.schemaname==='public'&&row.tablename==='employment'&&row.policyname==='employment_rls');
  expect(current.map(row=>row===target?{...row,qual:original!.qual}:row)).toEqual(originals);
  expect(await functionDefinitions()).toEqual(originalFunctions);
  if(next==='array_any')expect(target).toEqual(original);
  else expect(compact(target!.qual!)).toBe(compact(candidateQual).replaceAll('(idIN(SELECTunnest(app.visible_employment_ids())))','(idIN(SELECTunnest(app.visible_employment_ids())ASunnest))'));
 };
 try{
  const [constraint]=await owner.client`select contype,condeferrable,condeferred,convalidated,pg_get_constraintdef(oid) as definition
   from pg_constraint where conrelid='public.assignment'::regclass and conname='assignment_no_overlap'`;
  expect(constraint).toMatchObject({contype:'x',condeferrable:false,condeferred:false,convalidated:true});report.assignmentCardinalityPrerequisite=constraint;
  let baseline:ReturnType<typeof stablePage>|undefined;
  const settings:Record<string,unknown>[]=[];report.settings=settings;
  for(const variant of ['array_any','set_in'] as const){
   if(variant!==mode)await setMode(variant);
   for(let repeat=0;repeat<2;repeat++){
    capture=true;firstSample=repeat===0;const started=performance.now();let page:Page;
    try{page=await readEmployeeChoices(ctx,{companyIds:[b.companyId],selectedId:expectedLast.at(-1)});}
    finally{capture=false;firstSample=false;}
    timings[mode].push(performance.now()-started);
    expect(page.total).toBe(50000);expect(page.rows.map(row=>row.employmentId)).toEqual(expectedFirst);expect(page.rows).toHaveLength(25);expect(page.selected?.employmentId).toBe(expectedLast.at(-1));
    if(baseline)expect(stablePage(page)).toEqual(baseline);else baseline=stablePage(page);save();
   }
   expect(queries[mode]).toHaveLength(5);
   // Replay the exact SQL objects captured from the real port, with the same calling
   // principal and native RLS. No copied/manual approximation of page or point SQL.
   await database.withTenant(ctx,async tx=>{
    await assertAiPresentationPrincipalTx(tx,ctx);
    const [configuration]=await tx.execute(sql`select current_setting('work_mem') as work_mem,current_setting('hash_mem_multiplier') as hash_mem_multiplier,
     current_setting('statement_timeout') as statement_timeout,current_setting('lock_timeout') as lock_timeout`);
    settings.push({mode,...configuration});
    for(const [index,query]of queries[mode].entries()){
     const plan=Array.from(await tx.execute(sql`explain(analyze,buffers,format json) ${query}`)),doc=document(plan);
     expect(doc['Execution Time']).toBeGreaterThan(0);
     const expectedRows=index===0?25:index===1?1:index===4?0:1;
     expect(doc.Plan['Actual Rows']).toBe(expectedRows);
     const compiled=dialect.sqlToQuery(query);
     planCaptures.push({mode,index,purpose:['page','selected','company-options','department-options','unit-options'][index],sql:compiled.sql,parameters:compiled.params,plan});save();
    }
    const scalarStarted=performance.now(),[scalar]=await tx.execute<{own:boolean;foreign:boolean;unknown:boolean}>(sql`
     select app.can_see_employment(${expectedLast.at(-1)!}::uuid) as own,app.can_see_employment(${foreignEmployment}::uuid) as "foreign",
      app.can_see_employment(${randomUUID()}::uuid) as "unknown"`);
    expect(scalar).toEqual({own:true,foreign:false,unknown:false});components.push({mode,purpose:'canonical-scalar-employment-points',ms:performance.now()-scalarStarted,result:scalar});
   },{readOnlySnapshot:true});
  }
  expect({...settings[1],mode:'array_any'}).toEqual(settings[0]);
  // The scalar and HOD principals reuse the same physical app backend. HOD sees the
  // existing department population under the unchanged native visibility owner.
  const ids=expectedFirst.slice(0,2),people=await owner.db.select({id:employment.id,personId:employment.personId}).from(employment).where(inArray(employment.id,ids));
  const personFor=(id:string)=>people.find(row=>row.id===id)!.personId;
  const managerUser=await createAppUser(b.tenantId,personFor(ids[1]),'manager');
  await owner.db.insert(reportingLine).values({tenantId:b.tenantId,subordinateEmploymentId:ids[0],managerEmploymentId:ids[1],lineType:'administrative',validFrom:'2020-01-01'});
  const managerCtx:SessionContext={tenantId:b.tenantId,userId:managerUser,personId:personFor(ids[1]),roles:['manager']};
  for(const variant of ['array_any','set_in'] as const){
   if(variant!==mode)await setMode(variant);
   for(const [purpose,context]of [['admin-visible-person-function',ctx],['hod-visible-person-function',managerCtx]] as const){
    await database.withTenant(context,async tx=>{
     await assertAiPresentationPrincipalTx(tx,context);
     const plan=Array.from(await tx.execute(sql`explain(analyze,buffers,format json) select unnest(app.visible_person_ids()) as id`)),doc=document(plan);
     expect(doc.Plan['Actual Rows']).toBe(50000);expect(doc.Plan['Actual Loops']).toBe(1);
     components.push({mode,purpose,plan,ms:doc['Execution Time'],functionBoundary:'SECURITY DEFINER body remains opaque to outer EXPLAIN; full unchanged definition retained separately.'});save();
    },{readOnlySnapshot:true});
   }
   const grants=await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,managerUser)).returning();expect(grants).toHaveLength(1);
   try{await expect(readEmployeeChoices(managerCtx,{companyIds:[]})).rejects.toThrow('calling authority');}
   finally{await owner.db.insert(roleAssignment).values(grants);}
  }
  expect(pids.size).toBe(1);report.samePhysicalAppBackend=true;report.appPoolMax=single.client.options.max;
  report.phase='complete';report.interpretation='Compare full port and individual actual plans. Count/hash speed alone is not an adoption criterion.';save();
 }catch(error){report.phase='failed';report.errorType=error instanceof Error?error.name:typeof error;throw error;}
 finally{
  try{await setMode('array_any');expect(await policies()).toEqual(originals);expect(await functionDefinitions()).toEqual(originalFunctions);report.originalPoliciesAndFunctionsRestored=true;}
  finally{spy.mockRestore();await single.client.end({timeout:5});save();}
 }
},300000);
