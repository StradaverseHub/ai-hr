/** Hosted, disposable-database experiment only. No migration or runtime owner changes. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {cpus,totalmem} from 'node:os';
import {join} from 'node:path';
import {eq,inArray,sql,type SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {company,employment,person,reportingLine,roleAssignment} from '../db/schema';
import {assertAiPresentationPrincipalTx} from '../core/ai-principal';
import {readEmployeeChoices} from '../core/employee-choice';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner} from './harness';
import {workerDb} from './db-names';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';

const file='test/native-visibility-membership-plan.test.ts';
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

it.skipIf(!requested)('attributes native membership plans while preserving canonical choice authority and UUID-set results',async()=>{
 expect(process.env.RUNNER_ENVIRONMENT).toBe('github-hosted');
 expect(process.env.AIHR_FOCUSED_EVIDENCE_DIR).toBeTruthy();
 const poolId=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;
 expect(poolId).toBeTruthy();expect(process.env.WORKER_DB).not.toBe('0');
 // Refuse an arbitrary database, even if this file is invoked outside the normal focused controller.
 expect(new URL(process.env.TEST_DATABASE_URL!).pathname).toBe('/'+workerDb(poolId!));
 const report:Record<string,unknown>={kind:'DISPOSABLE_NATIVE_EMPLOYMENT_MEMBERSHIP_DIAGNOSTIC',releaseEligible:false,
  employees:50000,statementTimeoutMs:20000,lockTimeoutMs:300,testBudgetMs:300000,
  host:{cpuModels:[...new Set(cpus().map(cpu=>cpu.model))],logicalCpus:cpus().length,ramBytes:totalmem()},
  limitations:'Fictional retained-data component experiment; no deployment or practical speed claim follows from test PASS.'};
 const save=()=>writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR!,'native-visibility-membership-plan.json'),JSON.stringify(report,null,2));
 const fixture=await seedPersonnelNativeFixture(50000,report,phase=>{report.phase=phase;save();},save);
 const {b,ctx,foreign,foreignEmployment,expectedFirst,expectedLast}=fixture;
 const originals=await policies(),originalFunction=await visibilityDefinition();
 const original=originals.find(row=>row.schemaname==='public'&&row.tablename==='employment'&&row.policyname==='employment_rls');
 expect(original).toBeTruthy();
 expect(original).toMatchObject({permissive:'PERMISSIVE',roles:['ai_hr_app'],cmd:'ALL'});
 expect(compact(original!.qual!)).toBe(expectedQual);expect(compact(original!.with_check!)).toBe(expectedCheck);
 expect(expectedQual.split(oldMembership)).toHaveLength(3);expect(expectedQual).not.toMatch(/\bNOT\b/i);
 expect(originalFunction).toMatchObject({body_md5:'1bc7e85a740a98b9db79efb2b7768c8b',language:'plpgsql',definer:true,
  volatility:'s',parallel:'u',strict:false,leakproof:false,kind:'f',set_returning:false,return_type:'uuid[]',settings:['search_path=public']});
 report.originalEmploymentPolicy=original;report.visibilityFunction=originalFunction;
 const membershipPattern=/\(id\s*=\s*ANY\s*\(\(\s*SELECT\s+app\.visible_employment_ids\(\)\s+AS\s+visible_employment_ids\s*\)::uuid\[\]\)\)/g;
 expect(original!.qual!.match(membershipPattern)).toHaveLength(2);
 const candidateQual=original!.qual!.replace(membershipPattern,'(id IN (SELECT unnest(app.visible_employment_ids())))');
 expect(candidateQual.split('id IN (SELECT unnest(app.visible_employment_ids()))')).toHaveLength(3);
 expect(candidateQual).not.toContain(oldMembership);
 // A different connection-string key is essential: createDb otherwise reuses the existing max10 pool.
 const url=new URL(process.env.TEST_DATABASE_URL!);url.searchParams.set('application_name','native_membership_probe');
 const single=database.createDb(url.toString(),{max:1});expect(single.client.options.max).toBe(1);
 const pids=new Set<number>(),identities:unknown[]=[],statements:Record<string,unknown>[]=[],timings:Record<string,number[]>={};
 report.identities=identities;report.statements=statements;report.timings=timings;
 let mode:Mode='array_any',capture=false;
 const dialect=new PgDialect();
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>
  single.withTenant(context,async tx=>{
   await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='20s'`);
   const [identity]=await tx.execute<{role:string;pid:number;tenant:string;user:string;employment_rls:boolean;person_rls:boolean;company_rls:boolean;read_only:string;isolation:string}>(sql`
    select current_user as role,pg_backend_pid() as pid,app.current_tenant_id() as tenant,app.current_user_id() as "user",
     row_security_active('public.employment'::regclass) as employment_rls,row_security_active('public.person'::regclass) as person_rls,
     row_security_active('public.company'::regclass) as company_rls,current_setting('transaction_read_only') as read_only,
     current_setting('transaction_isolation') as isolation`);
   expect(identity).toMatchObject({role:'ai_hr_app',tenant:context.tenantId,user:context.userId,
    employment_rls:true,person_rls:true,company_rls:true,read_only:'on',isolation:'repeatable read'});
   pids.add(identity.pid);identities.push({mode,...identity});
   return read(new Proxy(tx,{get(target,key,receiver){
    if(key==='execute'&&capture)return async(query:SQL)=>{
     const entry:Record<string,unknown>={mode,sql:dialect.sqlToQuery(query).sql},start=performance.now();statements.push(entry);
     try{return await target.execute(query);}finally{entry.ms=performance.now()-start;save();}
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
  expect(await visibilityDefinition()).toEqual(originalFunction);
  if(next==='array_any')expect(target).toEqual(original);
  else expect(compact(target!.qual!)).toBe(compact(candidateQual).replaceAll('(idIN(SELECTunnest(app.visible_employment_ids())))','(idIN(SELECTunnest(app.visible_employment_ids())ASunnest))'));
  save();
 };
 try{
  const uuidA='00000000-0000-0000-0000-000000000001',uuidB='00000000-0000-0000-0000-000000000002';
  const semantics=await owner.client`with cases(label,id,ids,expected) as(values
   ('null-array',${uuidA}::uuid,null::uuid[],false),('empty-array',${uuidA}::uuid,array[]::uuid[],false),
   ('null-element',${uuidA}::uuid,array[null::uuid],false),('null-id',null::uuid,array[${uuidA}::uuid],false),
   ('match',${uuidA}::uuid,array[${uuidA}::uuid],true),('missing',${uuidB}::uuid,array[${uuidA}::uuid],false),
   ('duplicates',${uuidA}::uuid,array[${uuidA}::uuid,${uuidA}::uuid],true),
   ('match-with-null',${uuidA}::uuid,array[null::uuid,${uuidA}::uuid],true),
   ('missing-with-null',${uuidB}::uuid,array[null::uuid,${uuidA}::uuid],false))
   select label,(id=any(ids))is true as old_allowed,(id in(select unnest(ids)))is true as new_allowed,expected from cases order by label`;
  for(const row of semantics){expect(row.old_allowed,row.label).toBe(row.expected);expect(row.new_allowed,row.label).toBe(row.expected);}
  report.positiveRlsTruthTable=semantics;report.exactPositivePredecessorGuard=true;
  let baseline:ReturnType<typeof stablePage>|undefined;
  async function measure(){
   timings[mode]=[];
   for(let repeat=0;repeat<2;repeat++){
    capture=true;const start=performance.now();let page:Page;
    try{page=await readEmployeeChoices(ctx,{companyIds:[b.companyId],selectedId:expectedLast.at(-1)});}
    finally{capture=false;}
    timings[mode].push(performance.now()-start);
    expect(page.total).toBe(50000);expect(page.rows).toHaveLength(25);
    expect(page.rows.map(row=>row.employmentId)).toEqual(expectedFirst);expect(page.selected?.employmentId).toBe(expectedLast.at(-1));
    if(baseline)expect(stablePage(page)).toEqual(baseline);else baseline=stablePage(page);
    save();
   }
   // The actual unfiltered count population's native E/P/company joins and predicates.
   // assertAiPresentationPrincipalTx is mandatory here as in the canonical port above.
   const countPlan=await database.withTenant(ctx,async tx=>{
    await assertAiPresentationPrincipalTx(tx,ctx);
    const [settings]=await tx.execute<{work_mem:string;work_mem_bytes:number;hash_mem_multiplier:string;statement_timeout:string;lock_timeout:string;visible_ids:number}>(sql`
     select current_setting('work_mem') as work_mem,pg_size_bytes(current_setting('work_mem'))::float8 as work_mem_bytes,
      current_setting('hash_mem_multiplier') as hash_mem_multiplier,current_setting('statement_timeout') as statement_timeout,
      current_setting('lock_timeout') as lock_timeout,cardinality(app.visible_employment_ids()) as visible_ids`);
    expect(settings.visible_ids).toBe(50000);expect(settings.statement_timeout).toBe('20s');expect(settings.lock_timeout).toBe('300ms');
    const query=sql`select count(*)::int as total from public.employment e
     join public.person p on p.id=e.person_id and p.tenant_id=${b.tenantId}::uuid
     join public.company c on c.id=e.company_id and c.tenant_id=${b.tenantId}::uuid
     where e.tenant_id=${b.tenantId}::uuid and e.company_id=any(${'{'+b.companyId+'}'}::uuid[])
      and true and true and true and true`;
    const [count]=await tx.execute<{total:number}>(query);expect(count.total).toBe(50000);
    const plan=Array.from(await tx.execute(sql`explain(analyze,buffers,format json) ${query}`));
    const encoded=JSON.stringify(plan),hashedSubPlans=(encoded.match(/hashed SubPlan/g)??[]).length;
    if(mode==='set_in')expect(hashedSubPlans,'Candidate must demonstrate a hashed native membership plan').toBeGreaterThan(0);
    return {settings,plan,hashedSubPlans,configuredHashMemoryLimitBytes:settings.work_mem_bytes*Number(settings.hash_mem_multiplier),
     memoryEvidence:'Configured PostgreSQL hash allowance plus actual plan memory/temp-block fields; EXPLAIN does not expose hashed-SubPlan peak allocation.'};
   },{readOnlySnapshot:true});
   const plans=(report.countPlans??={}) as Record<string,typeof countPlan>;plans[mode]=countPlan;save();
  }
  await measure();await setMode('set_in');await measure();
  const plans=report.countPlans as Record<Mode,{settings:{work_mem:string;hash_mem_multiplier:string}} >;
  expect(plans.set_in.settings.work_mem).toBe(plans.array_any.settings.work_mem);
  expect(plans.set_in.settings.hash_mem_multiplier).toBe(plans.array_any.settings.hash_mem_multiplier);
  // Add the independent company-scope negative only after the exact50k benchmark.
  await setMode('array_any');
  const ids=expectedFirst.slice(0,2),people=await owner.db.select({id:employment.id,personId:employment.personId}).from(employment).where(inArray(employment.id,ids));
  const personFor=(id:string)=>people.find(row=>row.id===id)!.personId;
  const employeeUser=await createAppUser(b.tenantId,personFor(ids[0]),'employee');
  const managerUser=await createAppUser(b.tenantId,personFor(ids[1]),'manager');
  await owner.db.insert(reportingLine).values({tenantId:b.tenantId,subordinateEmploymentId:ids[0],managerEmploymentId:ids[1],lineType:'administrative',validFrom:'2020-01-01'});
  const employeeCtx:SessionContext={tenantId:b.tenantId,userId:employeeUser,personId:personFor(ids[0]),roles:['employee']};
  const managerCtx:SessionContext={tenantId:b.tenantId,userId:managerUser,personId:personFor(ids[1]),roles:['manager']};
  const otherCompany=randomUUID(),otherPerson=randomUUID(),otherEmployment=randomUUID();
  await owner.db.insert(company).values({id:otherCompany,tenantId:b.tenantId,legalName:'Fictional excluded company'});
  await owner.db.insert(person).values({id:otherPerson,tenantId:b.tenantId,fullName:'Fictional excluded employee'});
  await owner.db.insert(employment).values({id:otherEmployment,personId:otherPerson,tenantId:b.tenantId,companyId:otherCompany,hiredOn:'2020-01-01'});
  const scopedUser=await createAppUser(b.tenantId,null,'hr_admin');
  await owner.db.update(roleAssignment).set({companyId:b.companyId}).where(eq(roleAssignment.appUserId,scopedUser));
  const scopedCtx:SessionContext={tenantId:b.tenantId,userId:scopedUser,grants:[{role:'hr_admin',companyId:b.companyId}]};
  const scopeResults:Record<string,unknown>={};report.scopeResults=scopeResults;
  async function verifyScope(){
   // Every control exercises readEmployeeChoices, which performs the current calling-principal proof.
   const employee=await readEmployeeChoices(employeeCtx,{companyIds:[],selectedId:ids[1]});
   expect(employee.rows.map(row=>row.employmentId)).toEqual([ids[0]]);expect(employee.total).toBe(1);expect(employee.selected).toBeNull();
   const manager=await readEmployeeChoices(managerCtx,{companyIds:[],selectedId:ids[0]});
   expect(manager.rows.map(row=>row.employmentId)).toEqual(ids);expect(manager.total).toBe(2);expect(manager.selected?.employmentId).toBe(ids[0]);
   const foreignCompany=await readEmployeeChoices(scopedCtx,{companyIds:[otherCompany],selectedId:otherEmployment});
   expect(foreignCompany.total).toBe(0);expect(foreignCompany.rows).toEqual([]);expect(foreignCompany.selected).toBeNull();expect(foreignCompany.companyOptions).toEqual([]);
   const foreignTenant=await readEmployeeChoices({...adminCtx(foreign),grants:[{role:'hr_admin',companyId:null}]},{companyIds:[b.companyId],selectedId:ids[0]});
   expect(foreignTenant.total).toBe(0);expect(foreignTenant.rows).toEqual([]);expect(foreignTenant.selected).toBeNull();expect(foreignTenant.companyOptions).toEqual([]);
   const foreignSelected=await readEmployeeChoices(employeeCtx,{companyIds:[],selectedId:foreignEmployment});expect(foreignSelected.selected).toBeNull();
   const grants=await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,employeeUser)).returning();
   expect(grants).toHaveLength(1);
   try{await expect(readEmployeeChoices(employeeCtx,{companyIds:[],selectedId:ids[0]})).rejects.toThrow('calling authority');}
   finally{await owner.db.insert(roleAssignment).values(grants);}
   const restored=await readEmployeeChoices(employeeCtx,{companyIds:[],selectedId:ids[0]});
   expect(restored.rows.map(row=>row.employmentId)).toEqual([ids[0]]);expect(restored.total).toBe(1);expect(restored.selected?.employmentId).toBe(ids[0]);
   await expect(readEmployeeChoices({...ctx,personId:randomUUID()},{companyIds:[b.companyId]})).rejects.toThrow('calling authority');
   const observed={employee:stablePage(employee),manager:stablePage(manager),foreignCompany:stablePage(foreignCompany),foreignTenant:stablePage(foreignTenant),restored:stablePage(restored)};
   if(mode==='set_in')expect(observed).toEqual(scopeResults.array_any);scopeResults[mode]=observed;save();
  }
  await verifyScope();await setMode('set_in');await verifyScope();
  expect(pids.size).toBe(1);report.samePhysicalAppBackend=true;report.appPoolMax=single.client.options.max;
  report.actualGrantRevokedAndRestoredInBothModes=true;report.canonicalPortIdsCountsRowsSelectedOptionsParity=true;
  report.observedMeanSpeedRatio=timings.array_any.reduce((a,b)=>a+b,0)/timings.set_in.reduce((a,b)=>a+b,0);
  report.practicalSpeed='Assess recorded port timings independently; no speed threshold is part of this authority/plan test.';
  report.phase='complete';save();
 }catch(error){report.phase='failed';report.errorType=error instanceof Error?error.name:typeof error;throw error;}
 finally{
  try{
   await setMode('array_any');expect(await policies()).toEqual(originals);expect(await visibilityDefinition()).toEqual(originalFunction);
   report.originalPoliciesAndFunctionRestored=true;
  }finally{spy.mockRestore();await single.client.end({timeout:5});save();}
 }
},300000);
