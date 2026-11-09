import {createHash,randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {availableParallelism,cpus,totalmem} from 'node:os';
import {eq,sql,type SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {readEmployeeChoices,readEmployeeChoicesTx} from '../core/employee-choice';
import {isEmployeeChoicePage,type EmployeeChoice,type EmployeeChoicePage} from '../lib/employee-choice';
import {listEmployees} from '../core/read';
import {hireEmployee,setEmploymentAssignment,setReportingLine} from '../core/org';
import {archiveDepartment,assignRole,createCompany,createDepartment,revokeRole} from '../core/admin';
import {setAppUserArchived} from '../core/auth';
import {setLabelCriteria} from '../core/system-labels';
import {appUser,assignment,businessUnit,company,department,employment,labelCompanyAssignment,person,reportingLine,roleAssignment} from '../db/schema';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {workerDb} from './db-names';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';
import {createAssignmentAuthorityFixture} from './performance/employee-choice-assignment-authority';
import {departmentFacetBinds,isDepartmentFacet,representedDepartmentFacet} from './performance/employee-choice-department-pair-probe';
let organisationPageUnconfirmed=false;
beforeAll(migrateTestDb);
afterAll(async()=>{
 if(organisationPageUnconfirmed)throw new Error('Unconfirmed organisation page settlement requires the owned-job stop');
 await closeAll();
});
beforeEach(async()=>{
 if(organisationPageUnconfirmed)throw new Error('Unconfirmed organisation page settlement blocks another database case');
 await resetDb();
});

it('preserves native scope, exact JavaScript Unicode search, facets and independent deep selection',async()=>{
 const b=await seedBase(),ctx=adminCtx(b);
 const names=['Choice 000','Choice 001','İnci','ΟΣ','Ος','Σ','Straße','STRASSE','Kelvin','Emoji 😀','Percent %_\\',...Array.from({length:60},(_,i)=>'Choice '+String(i+2).padStart(3,'0'))];
 const ids:string[]=[];
 for(const [i,name] of names.entries()){
  const id=randomUUID(),pid=randomUUID();ids.push(id);
  await owner.db.insert(person).values({id:pid,tenantId:b.tenantId,fullName:name,primaryEmail:pid+'@example.invalid'});
  await owner.db.insert(employment).values({id,tenantId:b.tenantId,personId:pid,companyId:b.companyId,employeeCode:i===8?'KELVIN-CODE':'CODE-'+String(i).padStart(3,'0'),hiredOn:'2020-01-01',terminatedOn:i===1?'2024-01-01':null});
  await owner.db.insert(assignment).values({tenantId:b.tenantId,employmentId:id,companyId:b.companyId,departmentId:i===1?b.deptB:b.deptA,employmentType:'full_time',validFrom:'2020-01-01'});
 }
 const legacy=await listEmployees(ctx,[b.companyId]);expect(legacy).toHaveLength(names.length);
 const first=await readEmployeeChoices(ctx,{companyIds:[b.companyId],limit:25,selectedId:ids.at(-1)});
 expect(isEmployeeChoicePage(JSON.parse(JSON.stringify(first)))).toBe(true);expect(first.total).toBe(names.length);expect(first.rows.map(row=>row.employmentId)).toEqual(legacy.slice(0,25).map(row=>row.employmentId));
 expect(first.selected?.employmentId).toBe(ids.at(-1));expect(first.rows).toHaveLength(25);
 expect(first.allDepartmentOptions.map(row=>row.id).sort()).toEqual([b.deptA,b.deptB].sort());
 const page=await readEmployeeChoices(ctx,{companyIds:[b.companyId],limit:25,offset:25});
 expect(page.rows.map(row=>row.employmentId)).toEqual(legacy.slice(25,50).map(row=>row.employmentId));
 const outside=await readEmployeeChoices(ctx,{companyIds:[b.companyId],offset:1000,selectedId:ids[0]});expect(outside.rows).toEqual([]);expect(outside.total).toBe(names.length);expect(outside.selected?.employmentId).toBe(ids[0]);
 for(const query of ['i','i\u0307','ς','σ','k','STRASSE','%','_','\\','\0','😀','\ud83d']){
  const q=query.trim().toLowerCase(),expected=legacy.filter(row=>row.name.toLowerCase().includes(q)||(row.employeeCode??'').toLowerCase().includes(q));
  const actual=await readEmployeeChoices(ctx,{companyIds:[b.companyId],query,limit:200,selectedId:ids.at(-1)});
  expect(actual.rows.map(row=>row.employmentId),query).toEqual(expected.map(row=>row.employmentId));
  expect(actual.total,query).toBe(expected.length);expect(actual.selected?.employmentId).toBe(ids.at(-1));
 }
 expect((await readEmployeeChoices(ctx,{companyIds:[b.companyId],query:'kelvin'})).rows.map(row=>row.employmentId)).toEqual([ids[8]]);
 expect((await readEmployeeChoices(ctx,{companyIds:[b.companyId],status:'ended'})).rows.map(row=>row.employmentId)).toEqual([ids[1]]);
 const noMatch=await readEmployeeChoices(ctx,{companyIds:[b.companyId],query:'no such person',selectedId:ids.at(-1)});
 expect(noMatch.total).toBe(0);expect(noMatch.selected?.employmentId).toBe(ids.at(-1));
 const foreign=await seedBase(),outsider=await hireEmployee(adminCtx(foreign),{person:{fullName:'Foreign choice',primaryEmail:'foreign-choice@example.invalid'},companyId:foreign.companyId,departmentId:foreign.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 expect((await readEmployeeChoices(ctx,{companyIds:[],selectedId:outsider.employmentId})).selected).toBeNull();
 expect((await readEmployeeChoices(ctx,{companyIds:[foreign.companyId],selectedId:ids[0]})).total).toBe(0);
 await expect(readEmployeeChoices({...ctx,personId:randomUUID()},{companyIds:[]})).rejects.toThrow('calling authority');
 const employeeUser=await createAppUser(b.tenantId,legacy.find(row=>row.employmentId===ids[0])!.personId,'employee');
 const employeeCtx:SessionContext={tenantId:b.tenantId,userId:employeeUser,personId:legacy.find(row=>row.employmentId===ids[0])!.personId,roles:['employee']};
 const employeeLegacy=await listEmployees(employeeCtx,[]),employeePage=await readEmployeeChoices(employeeCtx,{companyIds:[],limit:200,selectedId:ids[0]});
 expect(employeePage.rows.map(row=>row.employmentId)).toEqual(employeeLegacy.map(row=>row.employmentId));expect(employeePage.selected?.employmentId).toBe(ids[0]);
 await expect(readEmployeeChoices(employeeCtx,{companyIds:[],labelMode:'labels'})).rejects.toThrow('administration access');
 const managerPerson=legacy.find(row=>row.employmentId===ids[2])!.personId,managerUser=await createAppUser(b.tenantId,managerPerson,'manager');
 await owner.db.insert(reportingLine).values({tenantId:b.tenantId,subordinateEmploymentId:ids[0],managerEmploymentId:ids[2],lineType:'administrative',validFrom:'2020-01-01'});
 const managerCtx:SessionContext={tenantId:b.tenantId,userId:managerUser,personId:managerPerson,roles:['manager']};
 const managerLegacy=await listEmployees(managerCtx,[]),managerPage=await readEmployeeChoices(managerCtx,{companyIds:[],limit:200});
 expect(managerPage.rows.map(row=>row.employmentId)).toEqual(managerLegacy.map(row=>row.employmentId));
 expect(managerPage.rows.map(row=>row.employmentId)).toContain(ids[0]);
 await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,employeeUser));
 await expect(readEmployeeChoices(employeeCtx,{companyIds:[]})).rejects.toThrow('calling authority');
},120000);

it('offers only represented native organisation identities and retains company narrowing and label collisions',async()=>{
 const b=await seedBase(),ctx=adminCtx(b),c2=randomUUID(),d2=randomUUID(),bu1=randomUUID(),bu2=randomUUID();
 await owner.db.insert(company).values({id:c2,tenantId:b.tenantId,legalName:'Second company'});
 await owner.db.update(department).set({label:'Finance display'}).where(eq(department.id,b.deptA));
 await owner.db.insert(department).values({id:d2,tenantId:b.tenantId,companyId:c2,name:'Finance Two',label:'Finance Two display'});
 await owner.db.insert(businessUnit).values([{id:bu1,tenantId:b.tenantId,companyId:b.companyId,code:'B1',name:'Operations',label:'Ops display'},{id:bu2,tenantId:b.tenantId,companyId:c2,code:'B2',name:'Operations',label:'Ops display'}]);
 for(const [i,companyId,departmentId,businessUnitId]of [[0,b.companyId,b.deptA,bu1],[1,c2,d2,bu2]] as const){
  const pid=randomUUID(),eid=randomUUID();await owner.db.insert(person).values({id:pid,tenantId:b.tenantId,fullName:'Company choice '+i,primaryEmail:pid+'@example.invalid'});
  await owner.db.insert(employment).values({id:eid,tenantId:b.tenantId,personId:pid,companyId,hiredOn:'2020-01-01',terminatedOn:i?'2099-01-01':null});
  await owner.db.insert(assignment).values({tenantId:b.tenantId,employmentId:eid,companyId,departmentId,businessUnitId,validFrom:'2020-01-01',employmentType:'full_time'});
 }
 const narrowed=await readEmployeeChoices(ctx,{companyIds:[],companyId:c2,status:'ended'});
 expect(narrowed.total).toBe(1);expect(narrowed.companyOptions.map(row=>row.id).sort()).toEqual([b.companyId,c2].sort());
 expect(narrowed.departmentOptions).toEqual([{id:d2,name:'Finance Two'}]);expect(narrowed.businessUnitOptions).toEqual([{id:bu2,name:'Operations'}]);
 expect(narrowed.allDepartmentOptions.map(row=>row.id).sort()).toEqual([b.deptA,d2].sort());
 const labels=await readEmployeeChoices(ctx,{companyIds:[],labelMode:'labels'});
 expect(labels.businessUnitOptions).toEqual([{id:bu1,name:'Ops display (B1)'},{id:bu2,name:'Ops display (B2)'}]);
 expect(labels.departmentOptions).toEqual([{id:b.deptA,name:'Finance display'},{id:d2,name:'Finance Two display'}]);
 const boundedScope=await readEmployeeChoices(ctx,{companyIds:[b.companyId]});expect(boundedScope.companyOptions).toEqual([{id:b.companyId,name:'Acme Sdn Bhd'}]);expect(boundedScope.allDepartmentOptions).toEqual([{id:b.deptA,name:'Finance'}]);
});

it('finishes behind an Access writer with exact native data and performs no audit writes',async()=>{
 const b=await seedBase(),ctx=adminCtx(b),hired=await hireEmployee(ctx,{person:{fullName:'Choice writer overlap',primaryEmail:'choice-overlap@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const [before]=await owner.client`select count(*)::int as count from domain_event where tenant_id=${b.tenantId}::uuid`;
 await owner.client.begin(async tx=>{
  await tx`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`;
  const actual=database.withTenant;const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(context,async tx=>{await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='3s'`);return read(tx);},options));
  try{const page=await readEmployeeChoices(ctx,{companyIds:[b.companyId],query:'writer',selectedId:hired.employmentId});
   expect(page.rows.map(row=>row.employmentId)).toEqual([hired.employmentId]);expect(page.total).toBe(1);
  }finally{spy.mockRestore();}
 });
 const [after]=await owner.client`select count(*)::int as count from domain_event where tenant_id=${b.tenantId}::uuid`;
 expect(after).toEqual(before);
});

it('pages the real 50k population without retaining whole employee DTOs or losing deep selection',context=>{
 const caseEnd=performance.now()+300000;
 const pending=(async()=>{
 const course=organisationPageCourse();
 const report:Record<string,unknown>={kind:'NATIVE_EMPLOYEE_CHOICE_COMPONENT_ONLY',releaseEligible:false,employees:50000,host:{node:process.version,logicalCpus:availableParallelism(),memoryBytes:totalmem(),cpuModels:[...new Set(cpus().map(cpu=>cpu.model))]}};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'employee-choice-50k.json'),JSON.stringify(report,null,2));};
 report.policies=await owner.client`select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public' and tablename in ('employment','person','assignment','company','department','business_unit') order by tablename,policyname`;save();
 const {b,ctx,expectedFirst,expectedLast,organisationTagSample}=await seedPersonnelNativeFixture(50000,report,name=>{report.phase=name;save();},save);
 report.fixtureReady=true;save();
 const timings:Record<string,number>={},statements:Record<string,unknown>[]=[];report.statements=statements;report.timings=timings;
 const actual=database.withTenant,dialect=new PgDialect();
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(context,async tx=>{
  await tx.execute(sql`set local lock_timeout='300ms'`);await tx.execute(sql`set local statement_timeout='20s'`);
  return read(new Proxy(tx,{get(target,key,receiver){
   if(key==='execute')return async(query:SQL)=>{
    const text=dialect.sqlToQuery(query).sql,entry:Record<string,unknown>={sql:text};statements.push(entry);save();
    if(/^\s*(select |with )/i.test(text))entry.plan=await target.execute(sql`explain (format json) ${query}`);
    const started=performance.now();try{return await target.execute(query);}catch(error){entry.error=String(error);throw error;}finally{entry.ms=performance.now()-started;save();}
   };
   const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
  }}));
 },options));
 try{
 let start=performance.now();const first=await readEmployeeChoices(ctx,{companyIds:[b.companyId],selectedId:expectedLast.at(-1)});timings.initialMs=performance.now()-start;
 expect(first.total).toBe(50000);expect(first.rows.map(row=>row.employmentId)).toEqual(expectedFirst);expect(first.selected?.employmentId).toBe(expectedLast.at(-1));
 start=performance.now();const deep=await readEmployeeChoices(ctx,{companyIds:[b.companyId],offset:49975});timings.deepMs=performance.now()-start;
 expect(deep.rows.map(row=>row.employmentId)).toEqual(expectedLast);expect(deep.total).toBe(50000);
 start=performance.now();const found=await readEmployeeChoices(ctx,{companyIds:[b.companyId],query:'PERF000050000'});timings.searchMs=performance.now()-start;
 expect(found.total).toBe(1);expect(found.rows.map(row=>row.employmentId)).toEqual(expectedLast.slice(-1));
 start=performance.now();const filtered=await readEmployeeChoices(ctx,{companyIds:[b.companyId],departmentId:b.deptA,status:'active',selectedId:expectedLast.at(-1)});timings.organisationFilteredMs=performance.now()-start;
 expect(isEmployeeChoicePage(JSON.parse(JSON.stringify(filtered)))).toBe(true);expect(filtered.total).toBe(40000);expect(filtered.rows.map(row=>row.employmentId)).toEqual(organisationTagSample.filter((_,index)=>(index+1)%5!==0).slice(0,25));expect(filtered.selected?.employmentId).toBe(expectedLast.at(-1));
 report.timings=timings;report.maxPageRows=Math.max(first.rows.length,deep.rows.length,found.rows.length,filtered.rows.length);report.exactNativeIdsAndCounts=true;save();
 }finally{spy.mockRestore();save();}
 if(course)await compareOrganisationPage({b,ctx,expectedLast,organisationTagSample},course,caseEnd,context.signal);
 })();
 context.onTestFinished(async()=>{await pending.catch(()=>{});});
 return pending;
},300000);

function organisationPageCourse(){
 if(process.env.AIHR_FOCUSED_TESTS!==JSON.stringify(['test/employee-choice-db.test.ts']))return undefined;
 const sha=/^[0-9a-f]{40}$/,source=process.env.AIHR_CI_HEAD,controller=process.env.AIHR_CI_CONTROL_HEAD;
 const pool=process.env.VITEST_POOL_ID??process.env.VITEST_WORKER_ID;
 const directory=process.env.AIHR_FOCUSED_EVIDENCE_DIR;
 if(process.env.CI!=='true'||process.env.GITHUB_ACTIONS!=='true'||process.env.RUNNER_ENVIRONMENT!=='github-hosted'||
    process.env.GITHUB_REPOSITORY!=='StradaverseHub/ai-hr'||process.platform!=='linux'||process.env.TEST_DB_NAMESPACE!=='aifocus'||
    process.env.WORKER_DB==='0'||!/^[12]$/.test(pool??'')||!source||!sha.test(source)||!controller||!sha.test(controller)||
    !/^\d+$/.test(process.env.GITHUB_RUN_ID??'')||!/^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT??'')||!directory)
  throw new Error('Organisation page comparison requires its hosted focused worker');
 const expectedDatabase=workerDb(pool!);
 for(const [client,user] of [[database.client,'ai_hr_app'],[owner.client,'postgres']] as const)
  expect(client.options).toMatchObject({database:expectedDatabase,user,host:['127.0.0.1'],port:[5433]});
 return {source,controller,directory,database:expectedDatabase};
}
const organisationPageHash=(text:string)=>createHash('sha256').update(text).digest('hex');
const organisationPageArray=(ids:readonly string[])=>'{'+ids.join(',')+'}';

type OrganisationPageInput={companyIds:[string];departmentId:string;businessUnitId?:string;status?:'active';selectedId:string};
function previousOrganisationPage(tenant:string,input:OrganisationPageInput){
 const from=sql`from ${employment}
 join ${person} on ${person.id}=${employment.personId} and ${person.tenantId}=${tenant}::uuid
 join ${company} on ${company.id}=${employment.companyId} and ${company.tenantId}=${tenant}::uuid
 left join lateral (select ${assignment.id},${assignment.departmentId},${assignment.businessUnitId}
  from ${assignment} where ${assignment.employmentId}=${employment.id} and ${assignment.validTo} is null
   and ${assignment.supersededAt} is null and ${assignment.tenantId}=${tenant}::uuid offset 0) as ${sql.identifier('assignment')} on true
 left join ${department} on ${department.id}=${assignment.departmentId} and ${department.tenantId}=${tenant}::uuid
 left join ${businessUnit} on ${businessUnit.id}=${assignment.businessUnitId} and ${businessUnit.tenantId}=${tenant}::uuid`;
 const where=sql`${employment.tenantId}=${tenant}::uuid and ${employment.companyId}=any(${organisationPageArray(input.companyIds)}::uuid[]) and true
  and ${input.businessUnitId?sql`${assignment.businessUnitId}=${input.businessUnitId}::uuid`:sql`true`}
  and ${assignment.departmentId}=${input.departmentId}::uuid
  and ${input.status?sql`${employment.terminatedOn} is null`:sql`true`}`;
 const page=sql`select ${employment.id} as "employmentId",${person.fullName} as name,${employment.employeeCode} as "employeeCode",
 ${company.legalName} as company,${employment.companyId} as "companyId",${assignment.departmentId} as "departmentId",
 null::text as "departmentCode",${department.name} as department,
 ${assignment.businessUnitId} as "businessUnitId",null::text as "businessUnitCode",
 ${businessUnit.name} as "businessUnit",
 case when ${employment.terminatedOn} is null then 'active' else 'ended' end as status,(count(*) over())::int as total ${from}
    where ${where} order by ${person.fullName},${employment.id},${assignment.id} limit ${25} offset ${0}`;
 return {page,count:sql`select count(*)::int as total ${from} where ${where}`};
}

type PagePlanNode={ [key:string]:unknown;Plans?:PagePlanNode[] };
function organisationPagePlan(raw:unknown,candidate:boolean,kind:'page'|'count',pageRows:number,assignmentKeys:number){
 if(!Array.isArray(raw)||raw.length!==1||!raw[0]||typeof raw[0]!=='object')throw new Error('Unexpected organisation page plan');
 const document=raw[0] as Record<string,unknown>,root=document.Plan as PagePlanNode;
 const number=(value:unknown)=>{
  if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new Error('Invalid organisation page plan counter');
  return value;
 };
 const active:{node:PagePlanNode;ancestors:PagePlanNode[]}[]=[];
 let visited=0;
 const walk=(node:PagePlanNode,ancestors:PagePlanNode[])=>{
  if(!node||typeof node!=='object'||typeof node['Node Type']!=='string'||++visited>2048||ancestors.length>64||
     (node.Plans!==undefined&&!Array.isArray(node.Plans)))throw new Error('Organisation page plan exceeds the node envelope');
  if(number(node['Actual Loops'])>0)active.push({node,ancestors});
  for(const child of node.Plans??[])walk(child,[...ancestors,node]);
 };
 walk(root,[]);
 expect(number(root['Actual Rows'])).toBe(kind==='page'?pageRows:1);
 const assignments=active.filter(({node})=>node['Relation Name']==='assignment');
 if(candidate){
  const membership=assignments.filter(({node:scan,ancestors})=>{
   const route=[...ancestors,scan];
   const subplan=route.findLastIndex(node=>node['Parent Relationship']==='SubPlan'&&/^SubPlan \d+$/.test(String(node['Subplan Name'])));
   const owner=route.slice(0,Math.max(0,subplan)).findLast(node=>node['Relation Name']==='employment');
   const source=route[subplan];
   return Boolean(owner&&source&&source['Actual Loops']===1&&source['Actual Rows']===assignmentKeys&&
    String(owner.Filter).includes('(hashed '+String(source['Subplan Name'])+') IS TRUE'));
  });
  expect(membership).toHaveLength(1);
  expect(membership[0].node).toMatchObject({'Actual Loops':1,'Actual Rows':assignmentKeys});
  expect(number(membership[0].node['Actual Rows'])+number(membership[0].node['Rows Removed by Filter']??0)).toBeLessThanOrEqual(50000);
  const hydrations=assignments.filter(entry=>entry!==membership[0]);
  expect(hydrations).toHaveLength(kind==='page'&&pageRows>0?1:0);
  for(const {node} of hydrations){
   expect(['assignment_no_overlap','assignment_employment_idx']).toContain(node['Index Name']);
   expect(number(node['Actual Loops'])).toBeLessThanOrEqual(pageRows);
   expect(String(node['Index Cond'])).toMatch(/\bemployment_id\s*=\s*[a-z_][a-z0-9_]*\.id\b/);
  }
  for(const {node,ancestors} of active){
   if(['department','business_unit'].includes(String(node['Relation Name']))&&
      !ancestors.some(parent=>parent['Parent Relationship']==='SubPlan'))
    expect(number(node['Actual Loops'])).toBeLessThanOrEqual(kind==='page'?pageRows:0);
   if(node['Node Type']==='CTE Scan'&&node['CTE Name']==='employee_choice_page')expect(node['Actual Loops']).toBe(1);
  }
 }
 return {executionMs:number(document['Execution Time']),planningMs:number(document['Planning Time']),
  sharedHits:number(root['Shared Hit Blocks']),sharedReads:number(root['Shared Read Blocks']),
  tempReads:number(root['Temp Read Blocks']),tempWrites:number(root['Temp Written Blocks']),jit:document.JIT??null,
  assignment:assignments.map(({node})=>({node:node['Node Type'],index:node['Index Name'],loops:node['Actual Loops'],
   rows:node['Actual Rows'],removed:node['Rows Removed by Filter']??0})),
  person:active.filter(({node})=>node['Relation Name']==='person').map(({node})=>({loops:node['Actual Loops'],rows:node['Actual Rows']}))};
}

type PageFixture=Pick<Awaited<ReturnType<typeof seedPersonnelNativeFixture>>,'b'|'ctx'|'expectedLast'|'organisationTagSample'>;
const pageRealm=sql`select current_database() as database, d.oid::text as oid, inet_server_addr()::text as address,
 inet_server_port() as port, extract(epoch from pg_postmaster_start_time())::text as cluster,
 current_user as role, session_user as login, pg_backend_pid() as pid, extract(epoch from a.backend_start)::text as started,
 current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as read_only,
 current_setting('statement_timeout') as statement_timeout,current_setting('lock_timeout') as lock_timeout,
 app.current_tenant_id()::text as tenant,app.current_user_id()::text as actor,
 not (r.rolsuper or r.rolbypassrls) as restricted,
 (select bool_and(row_security_active(t.oid)) and count(*)=6 from pg_class t where t.oid in
  ('public.employment'::regclass,'public.person'::regclass,'public.assignment'::regclass,
   'public.company'::regclass,'public.department'::regclass,'public.business_unit'::regclass)) as rls,
 (select jsonb_object_agg(name,setting) from pg_settings where category like 'Query Tuning%' or
  name in ('row_security','work_mem','hash_mem_multiplier','search_path','plan_cache_mode')) as planner
 from pg_database d join pg_roles r on r.rolname=current_user
 join pg_stat_activity a on a.pid=pg_backend_pid() where d.datname=current_database()`;
type PageRealm={database:string;oid:string;address:string;port:number;cluster:string;role:string;login:string;
 pid:number;started:string;isolation:string;read_only:string;statement_timeout:string;lock_timeout:string;
 tenant:string|null;actor:string|null;restricted:boolean;rls:boolean;planner:Record<string,string>};
const pageCatalogue=sql`select jsonb_build_object(
 'indexes',(select jsonb_agg(jsonb_build_array(c.oid::text,c.relname,i.indisvalid,i.indisready,i.indislive,pg_get_indexdef(c.oid)) order by c.oid)
   from pg_index i join pg_class c on c.oid=i.indexrelid where i.indrelid='public.assignment'::regclass),
 'policies',(select jsonb_agg(to_jsonb(p) order by p.tablename,p.policyname) from pg_policies p
   where p.schemaname='public' and p.tablename in ('employment','person','assignment','company','department','business_unit')),
 'relations',(select jsonb_agg(jsonb_build_array(t.oid::text,t.relacl::text,t.relrowsecurity,t.relforcerowsecurity,
  t.reltuples,t.relpages,t.relallvisible) order by t.oid) from pg_class t where t.oid in
  ('public.employment'::regclass,'public.person'::regclass,'public.assignment'::regclass,
   'public.company'::regclass,'public.department'::regclass,'public.business_unit'::regclass)),
 'exclusion',(select jsonb_build_object('kind',c.contype,'validated',c.convalidated,'deferred',c.condeferred,
   'deferrable',c.condeferrable,'definition',pg_get_constraintdef(c.oid)) from pg_constraint c
   where c.conrelid='public.assignment'::regclass and c.conname='assignment_no_overlap')) as facts`;
const pagePrepared=sql`select count(*)::int as total,coalesce(sum(generic_plans),0)::int as generic
 from pg_prepared_statements where statement like '%employee_choice_page as materialized%'
 or statement like '%count(*) over())::int as total from "employment"%'
 or statement like 'select count(*)::int as total from "employment"%'`;

async function compareOrganisationPage(fixture:PageFixture,course:NonNullable<ReturnType<typeof organisationPageCourse>>,caseEnd:number,signal:AbortSignal){
 const {b,ctx,expectedLast,organisationTagSample}=fixture,tenant=b.tenantId,dialect=new PgDialect();
 const activeEnd=caseEnd-25000,ownerDeadline=caseEnd;
 const requireTime=(deadline:number,remaining:number,phase:string)=>{
  if(performance.now()+remaining>deadline)throw new Error('Organisation page slot refused before '+phase);
 };
 const active=(phase:string,remaining=20000)=>{signal.throwIfAborted();requireTime(activeEnd,remaining,phase);};
 const cleanup=(phase:string)=>requireTime(ownerDeadline,20000,phase);
 const limit=async(tx:Tx,step:(label:string)=>void)=>{
  step('transaction limits');
  await tx.execute(sql`select set_config('statement_timeout','20s',true),set_config('lock_timeout','300ms',true)`);
 };
 const realm=async(tx:Tx,step:(label:string)=>void,role:'postgres'|'ai_hr_app')=>{
  step('native '+role+' identity');
  const [id]=await tx.execute<PageRealm>(pageRealm);
  expect(id).toMatchObject({database:course.database,address:'127.0.0.1',port:5433,role,login:role,statement_timeout:'20s',lock_timeout:'300ms'});
  expect(id.oid).toMatch(/^\d+$/);expect(id.cluster).toMatch(/^\d+(?:\.\d+)?$/);
  expect(id.started).toMatch(/^\d+(?:\.\d+)?$/);expect(id.pid).toBeGreaterThan(0);
  if(role==='ai_hr_app')expect(id).toMatchObject({isolation:'repeatable read',read_only:'on',tenant,actor:ctx.userId,restricted:true,rls:true});
  return id;
 };
 const sameWorker=(left:PageRealm,right:PageRealm)=>expect([left.database,left.oid,left.address,left.port,left.cluster])
  .toEqual([right.database,right.oid,right.address,right.port,right.cluster]);
 const sample=organisationTagSample.map((id,index)=>({id,ordinal:index+1}));
 expect(sample).toHaveLength(500);expect(new Set(sample.map(row=>row.id)).size).toBe(500);
 const represented=randomUUID(),empty=randomUUID(),sampleArray=organisationPageArray(organisationTagSample);
 const representedName='Fictional organisation subset',emptyName='Fictional unrepresented unit';
 const units=[{id:represented,code:'ORG-SUBSET',name:representedName},{id:empty,code:'ORG-EMPTY',name:emptyName}];
 const selectedId=expectedLast.at(-1)!;
 expect(selectedId).toBeTruthy();expect(organisationTagSample).not.toContain(selectedId);
 const activeRows=sample.filter(({ordinal})=>ordinal%5!==0).slice(0,25);
 const baseInput:OrganisationPageInput={companyIds:[b.companyId],departmentId:b.deptA,status:'active',selectedId};
 const profiles=[
  {label:'department-active',input:baseInput,total:40000,keys:50000,rows:activeRows,
   pageHash:'d1188796a341620b55226579fd316e66cf2a152afdb07a7a8a81b4879377739e'},
  {label:'department-and-unit',input:{...baseInput,businessUnitId:represented},total:400,keys:500,rows:activeRows,
   pageHash:'68afee9a56c7f04e8a7a065ee72a305f77838d084c7177f8d92a1ea0905750bf'},
  {label:'empty-unit',input:{...baseInput,businessUnitId:empty,status:undefined},total:0,keys:0,rows:[],
   pageHash:'8aea24203fe5571c0ea0533b8194a025bbd24e03d4e168c112f8d22b05b3127d'},
 ] as const;
 type Compiled=ReturnType<PgDialect['sqlToQuery']>;
 const seal=({sql:text,params}:Compiled)=>({sql:organisationPageHash(text),params:organisationPageHash(JSON.stringify(params))});
 const expectedRow=({id,ordinal}:{id:string;ordinal:number},unit:boolean)=>{
  const n=String(ordinal).padStart(9,'0'),row=choiceRow(id,'Fictional retained Personnel '+n,'PERF'+n,b.companyId,'Acme Sdn Bhd',
   b.deptA,'Finance',ordinal%5===0?'ended':'active');
  return unit?{...row,businessUnitId:represented,businessUnit:representedName}:row;
 };
 const references=profiles.map(profile=>{
  Object.freeze(profile.input.companyIds);Object.freeze(profile.input);
  const old=previousOrganisationPage(tenant,profile.input),page=dialect.sqlToQuery(old.page),count=dialect.sqlToQuery(old.count);
  const before=[tenant,tenant,tenant,tenant,tenant,tenant,organisationPageArray(profile.input.companyIds),
   ...(profile.input.businessUnitId?[profile.input.businessUnitId]:[]),b.deptA];
  expect(page.params).toEqual([...before,25,0]);expect(count.params).toEqual(before);
  expect(seal(page).sql).toBe(profile.pageHash);
  if(profile.total===0)expect(seal(count).sql).toBe('72c52c3260b4df4181d8c508c9563d70a94189b04a35195e6ae1779d95e84101');
  Object.freeze(old.page.queryChunks);Object.freeze(old.page);Object.freeze(old.count.queryChunks);Object.freeze(old.count);
  const expected=choicePage(profile.rows.map(row=>expectedRow(row,true)),[{id:b.companyId,name:'Acme Sdn Bhd'}],[{id:b.deptA,name:'Finance'}],{
   total:profile.total,selected:expectedRow({id:selectedId,ordinal:50000},false),
   businessUnitOptions:[{id:represented,name:representedName}],
   filters:{...emptyFilters,departmentId:b.deptA,businessUnitId:profile.input.businessUnitId??'',status:profile.input.status??''},
  });
  const identityBinds=[tenant,tenant,tenant,organisationPageArray(profile.input.companyIds),tenant,b.deptA,
   ...(profile.input.businessUnitId?[profile.input.businessUnitId]:[])];
  const productBinds={page:[...identityBinds,25,0,tenant,tenant,tenant,tenant,tenant,tenant,organisationPageArray(profile.input.companyIds)],
   count:identityBinds};
  return {...profile,old,oldSeals:{page:seal(page),count:seal(count)},productBinds,expected};
 });
 const epochs=['A0','B0','B1','A1'] as const;
 type Epoch=typeof epochs[number];
 type Target='page'|'count';
 type Times=Partial<Record<Target,number>>;
 type Sample={epoch:Epoch;label:string;wallMs:number;ordinary:Times;instrumented:Times;dtoVerified:boolean};
 const observations:Sample[]=[],rawPlans:{epoch:Epoch;label:string;kind:Target;raw:unknown}[]=[];
 const planSummaries:Record<string,unknown>[]=[];
 const metadata:Record<string,unknown>={kind:'FICTIONAL_NATIVE_ORGANISATION_PAGE_COMPONENT_ONLY',releaseEligible:false,
  source:course.source,controller:course.controller,caseEnd,activeEnd,epochs,observations,planSummaries,
  historical:{run:42387710131,source:'1de4d9047a7e8d58f79693ba614b2e5e0a586a43',wholePortTargetMet:false},
  priorCurrent:{run:42555973651,source:'a2936e6ba64695c4f92e277a69545e3d66c7673b',pageStatement:17},
  profiles:references.map(({label,total,keys,oldSeals})=>({label,total,keys,oldSeals}))};
 const save=()=>{
  const facts=JSON.stringify(metadata),plans=JSON.stringify(rawPlans);
  if(Buffer.byteLength(facts)>65536||Buffer.byteLength(plans)>4*1024*1024)throw new Error('Organisation page evidence exceeds its byte cap');
  writeFileSync(join(course.directory,'employee-choice-organisation-page-private.json'),JSON.stringify({metadata,rawPlans}),{mode:0o600});
 };
 const runRead=async(tx:Tx,epoch:Epoch,profile:typeof references[number])=>{
  const product=epoch==='B0'||epoch==='B1',count=profile.total===0;
  const positions=['principal','page',...(count?['count']:[]),'selected','company','department','unit'];
  const calls:{position:string;compiled:Compiled;original:SQL;forwarded:SQL;ms:number}[]=[];
  const guarded=new Proxy(tx,{get(target,key,receiver){
   if(key==='execute')return async(query:SQL)=>{
    active('product '+profile.label+' statement');
    const compiled=dialect.sqlToQuery(query),text=compiled.sql.trimStart(),position=positions[calls.length];
    const matches=position==='principal'?text.startsWith('select exists(select 1 from public.app_user'):
     position==='page'?text.startsWith('with employee_choice_page as materialized(select')&&text.includes(')) is true'):
     position==='count'?text.startsWith('select count(*)::int as total from "employment"')&&text.includes(')) is true'):
     position==='selected'?text.startsWith('select "employment"."id" as "employmentId",')&&text.endsWith('limit 1'):
     position==='company'?text.startsWith('select "company"."id" as "companyId",')&&!text.includes('cross join'):
     position==='department'?isDepartmentFacet(text):
     position==='unit'?text.startsWith('select "company"."id" as "companyId",')&&text.includes('cross join "business_unit"'):false;
    if(!matches)throw new Error('Unexpected organisation page product statement '+position);
    const timed=position==='page'||position==='count';
    if(timed)expect(compiled.params).toEqual(profile.productBinds[position]);
    const forwarded=!product&&timed?profile.old[position]:query;
    const started=performance.now(),rows=await target.execute(forwarded);
    calls.push({position,compiled,original:query,forwarded,ms:performance.now()-started});
    return rows;
   };
   const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
  }});
  active(profile.label+' ordinary port');
  const started=performance.now(),result=await readEmployeeChoicesTx(guarded,ctx,profile.input,signal),wallMs=performance.now()-started;
  const observation:Sample={epoch,label:profile.label,wallMs,ordinary:{},instrumented:{},dtoVerified:false};
  observations.push(observation);save();
  expect(calls.map(call=>call.position)).toEqual(positions);
  expect(choicesWithoutContext(result)).toEqual(profile.expected);
  const seals=calls.map(({compiled})=>seal(compiled));
  const allSeals=(metadata.productSeals??={}) as Record<string,ReturnType<typeof seal>[]>;
  if(epoch==='A0')allSeals[profile.label]=seals;else expect(seals).toEqual(allSeals[profile.label]);
  observation.dtoVerified=true;
  for(const call of calls){
   if(call.position!=='page'&&call.position!=='count')continue;
   const kind=call.position;
   expect(call.forwarded).toBe(product?call.original:profile.old[kind]);
   expect(seal(dialect.sqlToQuery(call.forwarded))).toEqual(product?seal(call.compiled):profile.oldSeals[kind]);
   observation.ordinary[kind]=call.ms;save();
   active(profile.label+' native '+kind+' plan');
   const [row]=await tx.execute<{'QUERY PLAN':unknown}>(sql`explain (analyze,buffers,verbose,settings,timing off,format json) ${call.forwarded}`);
   const raw=row?.['QUERY PLAN'];
   if(!raw||rawPlans.length>=16||Buffer.byteLength(JSON.stringify(raw))>1024*1024)throw new Error('Organisation page raw plan inventory exceeded');
   rawPlans.push({epoch,label:profile.label,kind,raw});save();
   const details=organisationPagePlan(raw,product,kind,profile.rows.length,profile.keys);
   observation.instrumented[kind]=details.executionMs;
   planSummaries.push({epoch,label:profile.label,kind,...details});save();
  }
 };
 type FixtureHistory={published:number;classifications:number;events:number;organisationRevision:string|null};
 const fixtureHistory=sql`select
  (select count(*)::int from public.company_organisation_run where tenant_id=${tenant}::uuid and state='published') as published,
  (select count(*)::int from public.employment_organisation_classification where tenant_id=${tenant}::uuid) as classifications,
  (select count(*)::int from public.domain_event where tenant_id=${tenant}::uuid) as events,
  (select revision::text from public.company_organisation_source_epoch where tenant_id=${tenant}::uuid) as "organisationRevision"`;
 let historyBefore:FixtureHistory|undefined,ownerIdentity:PageRealm|undefined,touched:{id:string;employmentId:string}[]=[];
 let fixtureCommitted=false,restored=false,workFailed=false,restoreFailed=false;
 let workFailure:unknown,restoreFailure:unknown;
 const readSnapshots=new Set<Promise<unknown>>();
 const track=<T>(work:Promise<T>)=>{
  readSnapshots.add(work);
  void work.then(()=>readSnapshots.delete(work),()=>readSnapshots.delete(work));
  return work;
 };
 const publicPortMs:Record<string,number>={};
 metadata.publicPortMs=publicPortMs;
 try{
  save();active('owned fixture preparation',110000);
  const preparedOwner=await owner.db.transaction(async tx=>{
   await limit(tx,active);
   const id=await realm(tx,active,'postgres');
   ownerIdentity=id;metadata.owner=id;
   active('exact empty fixture unit baseline');
   const [initial]=await tx.execute<{units:number;assignments:number;eligible:number}>(sql`select
    (select count(*)::int from public.business_unit where tenant_id=${tenant}::uuid) as units,
    (select count(*)::int from public.assignment where tenant_id=${tenant}::uuid) as assignments,
    (select count(*)::int from public.assignment where tenant_id=${tenant}::uuid and company_id=${b.companyId}::uuid
     and department_id=${b.deptA}::uuid and employment_id=any(${sampleArray}::uuid[])
     and valid_to is null and superseded_at is null and business_unit_id is null) as eligible`);
   expect(initial).toEqual({units:0,assignments:50000,eligible:500});
   active('fictional legacy organisation history');
   [historyBefore]=await tx.execute<FixtureHistory>(fixtureHistory);
   expect(historyBefore).toMatchObject({published:0,classifications:0});
   active('fictional unit insertion');
   const inserted=await tx.execute<{id:string;code:string;name:string}>(sql`insert into public.business_unit(id,tenant_id,company_id,code,name)
    select u.id,${tenant}::uuid,${b.companyId}::uuid,u.code,u.name
    from jsonb_to_recordset(${JSON.stringify(units)}::jsonb) as u(id uuid,code text,name text) returning id::text,code,name`);
   expect(Array.from(inserted).sort((a,c)=>a.id.localeCompare(c.id))).toEqual([...units].sort((a,c)=>a.id.localeCompare(c.id)));
   active('exact fictional Assignment tags');
   touched=Array.from(await tx.execute<{id:string;employmentId:string}>(sql`update public.assignment set business_unit_id=${represented}::uuid
    where tenant_id=${tenant}::uuid and company_id=${b.companyId}::uuid and department_id=${b.deptA}::uuid
     and employment_id=any(${sampleArray}::uuid[]) and valid_to is null and superseded_at is null and business_unit_id is null
    returning id::text,employment_id::text as "employmentId"`));
   expect(touched.map(row=>row.employmentId).sort()).toEqual([...organisationTagSample].sort());
   return id;
  });
  fixtureCommitted=true;metadata.fixture={units:2,tagged:touched.length,committed:true};save();
  active('ABBA admission with cleanup reserved',90000);
  await database.withTenant(ctx,tx=>track((async()=>{
   await limit(tx,active);
   const identity=await realm(tx,active,'ai_hr_app');
   sameWorker(identity,preparedOwner);expect(identity.pid).not.toBe(preparedOwner.pid);
   metadata.app=identity;
   active('initial planner catalogue');
   const [catalogue]=await tx.execute<{facts:{indexes:unknown[][];policies:{tablename:string;policyname:string;qual:string}[];
    exclusion:{kind:string;validated:boolean;deferred:boolean;deferrable:boolean;definition:string}}}>(pageCatalogue);
   const {indexes,policies,exclusion}=catalogue.facts;
   expect(indexes.map(row=>row[1]).sort()).toEqual(['assignment_company_idx','assignment_employment_idx','assignment_no_overlap','assignment_pkey']);
   expect(indexes.every(row=>row[2]===true&&row[3]===true&&row[4]===true)).toBe(true);
   expect(exclusion).toMatchObject({kind:'x',validated:true,deferred:false,deferrable:false});
   expect(exclusion.definition).toContain("employment_id WITH =, daterange(valid_from, valid_to, '[)'::text) WITH &&");
   expect(exclusion.definition).toContain('superseded_at IS NULL');
   for(const relation of ['assignment','employment'])
    expect(policies.find(row=>row.tablename===relation&&row.policyname===relation+'_rls')?.qual).toContain('unnest');
   metadata.catalogue=catalogue.facts;save();
   for(const epoch of epochs){
    const ordered=epoch==='B0'||epoch==='A1'?[...references].reverse():references;
    for(const profile of ordered)await runRead(tx,epoch,profile);
   }
   active('prepared statement evidence');
   const [prepared]=await tx.execute<{total:number;generic:number}>(pagePrepared);
   expect(prepared.total).toBeLessThanOrEqual(100);expect(prepared.generic).toBe(0);metadata.prepared=prepared;
   active('final planner catalogue');
   expect((await tx.execute(pageCatalogue))[0]).toEqual(catalogue);
   expect(await realm(tx,active,'ai_hr_app')).toEqual(identity);
   active('ABBA transaction completion',0);
  })()),{readOnlySnapshot:true,readSignal:signal});
  // Independently time the public port including its checkout and settlement.
  const actual=database.withTenant;
  const publicSpy=vi.spyOn(database,'withTenant').mockImplementation(<T>(session:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>
   actual(session,tx=>track((async()=>{
    await limit(tx,active);
    return read(new Proxy(tx,{get(target,key,receiver){
     if(key==='execute')return (query:SQL)=>{active('public page statement');return target.execute(query);};
     const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
    }}));
   })()),options));
  try{
   for(const profile of references){
    active('public '+profile.label+' port');
    const started=performance.now(),page=await readEmployeeChoices(ctx,profile.input,signal);
    publicPortMs[profile.label]=performance.now()-started;save();
    expect(choicesWithoutContext(page)).toEqual(profile.expected);
   }
  }finally{publicSpy.mockRestore();}
  active('public port evidence completion',0);
 }catch(error){workFailed=true;workFailure=error;}
 finally{
  await Promise.allSettled([...readSnapshots]);
  const admitted=ownerIdentity;
  if(admitted)try{
   cleanup('owned fixture restoration');
   await owner.db.transaction(async tx=>{
    await limit(tx,cleanup);
    const id=await realm(tx,cleanup,'postgres');sameWorker(id,admitted);
    cleanup('native app settlement');
    const [settlement]=await tx.execute<{transactions:number}>(sql`select count(*)::int as transactions from pg_stat_activity
     where datname=current_database() and usename='ai_hr_app' and xact_start is not null`);
    expect(settlement.transactions).toBe(0);metadata.nativeAppSettled=true;
    cleanup('exact fixture ownership');
    const owned=Array.from(await tx.execute<{id:string;code:string;name:string}>(sql`select id::text,code,name from public.business_unit
     where tenant_id=${tenant}::uuid and company_id=${b.companyId}::uuid and id=any(${organisationPageArray(units.map(unit=>unit.id))}::uuid[])
     order by code`));
    expect(owned).toEqual(owned.length>0||fixtureCommitted?[units[1],units[0]]:[]);
    cleanup('native Assignment restoration');
    const ids=organisationPageArray(touched.map(row=>row.id));
    const reverted=Array.from(await tx.execute<{id:string;employmentId:string}>(sql`update public.assignment set business_unit_id=null
     where tenant_id=${tenant}::uuid and company_id=${b.companyId}::uuid and department_id=${b.deptA}::uuid
      and id=any(${ids}::uuid[]) and employment_id=any(${sampleArray}::uuid[]) and valid_to is null and superseded_at is null
      and business_unit_id=${represented}::uuid returning id::text,employment_id::text as "employmentId"`));
    expect(reverted.sort((a,c)=>a.id.localeCompare(c.id))).toEqual(owned.length?[...touched].sort((a,c)=>a.id.localeCompare(c.id)):[]);
    cleanup('owned fixture unit removal');
    const removed=await tx.execute<{id:string}>(sql`delete from public.business_unit where tenant_id=${tenant}::uuid
     and company_id=${b.companyId}::uuid and id=any(${organisationPageArray(units.map(unit=>unit.id))}::uuid[]) returning id::text`);
    expect(Array.from(removed,row=>row.id).sort()).toEqual(owned.map(row=>row.id).sort());
    cleanup('original fixture verification');
    const [original]=await tx.execute<{units:number;tags:number}>(sql`select
     (select count(*)::int from public.business_unit where tenant_id=${tenant}::uuid) as units,
     (select count(*)::int from public.assignment where tenant_id=${tenant}::uuid
      and employment_id=any(${sampleArray}::uuid[]) and business_unit_id is null and valid_to is null and superseded_at is null) as tags`);
    expect(original).toEqual({units:0,tags:500});metadata.restoredFixture=original;
    if(historyBefore){
     cleanup('fictional organisation history verification');
     const [historyAfter]=await tx.execute<FixtureHistory>(fixtureHistory);
     const {organisationRevision:beforeRevision,...beforeBusinessHistory}=historyBefore;
     const {organisationRevision:afterRevision,...afterBusinessHistory}=historyAfter;
     expect(afterBusinessHistory).toEqual(beforeBusinessHistory);
     if(fixtureCommitted)expect(BigInt(afterRevision??0)>BigInt(beforeRevision??0)).toBe(true);
     // Native dependency epochs advance on fixture writes; their owner is the disposable worker teardown.
     metadata.fixtureHistory={before:historyBefore,after:historyAfter};
    }
    requireTime(ownerDeadline,0,'fixture restoration before commit');
   });
   requireTime(ownerDeadline,0,'acknowledged fixture restoration');
   restored=true;
  }catch(error){restoreFailed=true;restoreFailure=error;organisationPageUnconfirmed=true;}
 }
 const errorHash=(error:unknown)=>error instanceof Error?organisationPageHash(error.message):null;
 metadata.failures={work:errorHash(workFailure),cleanup:errorHash(restoreFailure)};
 metadata.restored=restored;
 const failures=[...(workFailed?[workFailure]:[]),...(restoreFailed?[restoreFailure]:[])];
 try{save();}catch(error){failures.push(error);}
 if(failures.length)throw new AggregateError(failures,'Native organisation page work or cleanup refused');
 expect(restored).toBe(true);
 expect(rawPlans).toHaveLength(16);
 const outcomes=references.map(({label,total})=>{
  const arms=epochs.map(epoch=>observations.find(row=>row.epoch===epoch&&row.label===label));
  if(arms.some(arm=>!arm?.dtoVerified))throw new Error('Incomplete organisation page ABBA');
  const [a0,b0,b1,a1]=arms as Sample[];
  const kinds:Target[]=total===0?['page','count']:['page'];
  const metric=(field:'ordinary'|'instrumented',kind:Target)=>Math.max(b0[field][kind]??Infinity,b1[field][kind]??Infinity)<
   Math.min(a0[field][kind]??-Infinity,a1[field][kind]??-Infinity);
  return {label,ordinary:kinds.every(kind=>metric('ordinary',kind)),instrumented:kinds.every(kind=>metric('instrumented',kind)),
   wholeRead:Math.max(b0.wallMs,b1.wallMs)<Math.min(a0.wallMs,a1.wallMs),
   targetMet:publicPortMs[label]<=1000&&Math.max(b0.wallMs,b1.wallMs)<=1000};
 });
 metadata.outcomes=outcomes;save();
 expect(outcomes).toEqual(references.map(({label})=>({label,ordinary:true,instrumented:true,wholeRead:true,targetMet:true})));
}

it.each(['count','cursor'] as const)('stops further SQL after a disconnected %s and releases the native transaction',async(mode)=>{
 const b=await seedBase(),ctx=adminCtx(b),controller=new AbortController(),stop=Error('Controlled choice disconnect');
 const actual=database.withTenant;let afterAbort=0,sawRead=false;
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(context,tx=>read(new Proxy(tx,{
  get(target,key,receiver){
   if(key==='execute')return async(...args:unknown[])=>{
    if(controller.signal.aborted)afterAbort++;
    const result=await Reflect.apply(target.execute,target,args);
    if(mode==='count'?Array.isArray(result)&&result[0]&&typeof result[0].total==='number':new PgDialect().sqlToQuery(args[0] as SQL).sql.startsWith('fetch forward')){sawRead=true;controller.abort(stop);}
    return result;
   };
   const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
  },
 })),options));
 try{await expect(readEmployeeChoices(ctx,{companyIds:[b.companyId],query:mode==='cursor'?'cancelled 人 search':undefined},controller.signal)).rejects.toBe(stop);}
 finally{spy.mockRestore();}
 expect(sawRead).toBe(true);expect(afterAbort).toBe(0);
 expect((await readEmployeeChoices(ctx,{companyIds:[b.companyId]})).total).toBe(0);
});

const emptyFilters={query:'',companyId:'',departmentId:'',businessUnitId:'',status:''};
const choicesWithoutContext=({contextId:_contextId,...page}:EmployeeChoicePage)=>page;
const choiceRow=(employmentId:string,name:string,employeeCode:string|null,companyId:string,company:string,
 departmentId:string|null,department:string|null,status:EmployeeChoice['status']='active',departmentCode:string|null=null):EmployeeChoice=>({
 employmentId,name,employeeCode,companyId,company,departmentId,department,departmentCode,
 businessUnit:null,businessUnitId:null,businessUnitCode:null,status,
});
const choicePage=(rows:EmployeeChoice[],companyOptions:EmployeeChoicePage['companyOptions'],departmentOptions:EmployeeChoicePage['departmentOptions'],
 extra:Partial<Omit<EmployeeChoicePage,'contextId'>>={}):Omit<EmployeeChoicePage,'contextId'>=>({
 rows,total:rows.length,selected:null,offset:0,limit:25,filters:emptyFilters,labelMode:'names',companyOptions,
 departmentOptions,allDepartmentOptions:departmentOptions,businessUnitOptions:[],...extra,
});

it('retains exact department facets for shared origin, multiple employments, scope and current native login',async()=>{
 const b=await seedBase(),foreign=await seedBase(),ctx=adminCtx(b);
 const {id:otherCompany}=await createCompany(ctx,{legalName:'Zeta Facet Company'});
 const shared={id:b.deptA,name:'Finance'},operations={id:b.deptB,name:'Operations'};
 const acme={id:b.companyId,name:'Acme Sdn Bhd'},zeta={id:otherCompany,name:'Zeta Facet Company'};
 await setLabelCriteria(ctx,{kind:'department',labelId:shared.id,isGlobal:false,companyIds:[acme.id,zeta.id]});
 const criteria=await owner.db.select({companyId:labelCompanyAssignment.companyId}).from(labelCompanyAssignment).where(eq(labelCompanyAssignment.labelId,shared.id));
 expect(criteria.map(value=>value.companyId).sort()).toEqual([acme.id,zeta.id].sort());
 const [origin]=await owner.db.select({companyId:department.companyId}).from(department).where(eq(department.id,shared.id));expect(origin.companyId).toBe(acme.id);
 const first=await hireEmployee(ctx,{person:{fullName:'Alpha %_\\ 人',primaryEmail:'alpha-facet@example.invalid'},companyId:acme.id,departmentId:operations.id,employeeCode:'FACET-A',hiredOn:'2020-01-01',employmentType:'full_time'});
 const second=await hireEmployee(ctx,{person:{id:first.personId},companyId:zeta.id,departmentId:shared.id,employeeCode:'FACET-B',hiredOn:'2020-01-01',employmentType:'full_time'});
 const [association]=await owner.db.select({personId:employment.personId,companyId:employment.companyId,departmentId:assignment.departmentId}).from(employment)
  .innerJoin(assignment,eq(assignment.employmentId,employment.id)).where(eq(employment.id,second.employmentId));
 expect(association).toEqual({personId:first.personId,companyId:zeta.id,departmentId:shared.id});
 const alpha=choiceRow(first.employmentId,'Alpha %_\\ 人','FACET-A',acme.id,acme.name,operations.id,operations.name);
 const beta=choiceRow(second.employmentId,'Alpha %_\\ 人','FACET-B',zeta.id,zeta.name,shared.id,shared.name);
 const both=[alpha,beta].sort((left,right)=>left.employmentId<right.employmentId?-1:1);
 expect(choicesWithoutContext(await readEmployeeChoices(ctx,{companyIds:[]}))).toEqual(choicePage(both,[acme,zeta],[shared,operations]));
 const narrowed=await readEmployeeChoices(ctx,{companyIds:[],companyId:zeta.id,query:'%_\\ 人',status:'active',selectedId:alpha.employmentId,limit:1});
 expect(choicesWithoutContext(narrowed)).toEqual(choicePage([beta],[acme,zeta],[shared],{
  allDepartmentOptions:[shared,operations],selected:alpha,limit:1,filters:{...emptyFilters,companyId:zeta.id,query:'%_\\ 人',status:'active'},
 }));
 const outside=await hireEmployee(adminCtx(foreign),{person:{fullName:'Foreign Facet',primaryEmail:'foreign-facet@example.invalid'},companyId:foreign.companyId,departmentId:foreign.deptA,employeeCode:'FACET-F',hiredOn:'2020-01-01',employmentType:'full_time'});
 expect(choicesWithoutContext(await readEmployeeChoices(ctx,{companyIds:[foreign.companyId],selectedId:outside.employmentId}))).toEqual(choicePage([],[],[]));
 const [account]=await owner.db.insert(appUser).values({tenantId:b.tenantId,workosUserId:'user_'+randomUUID()}).returning({id:appUser.id});
 const scopedGrant=await assignRole(ctx,{appUserId:account.id,role:'hr_admin',companyId:zeta.id});
 const scoped:SessionContext={tenantId:b.tenantId,userId:account.id,grants:[{role:'hr_admin',companyId:zeta.id}]};
 expect(choicesWithoutContext(await readEmployeeChoices(scoped,{companyIds:[]}))).toEqual(choicePage([beta],[zeta],[shared]));
 await expect(readEmployeeChoices({...scoped,grants:[{role:'hr_admin',companyId:null}]},{companyIds:[]})).rejects.toThrow('calling authority');
 await revokeRole(ctx,{roleAssignmentId:scopedGrant.id});
 await expect(readEmployeeChoices(scoped,{companyIds:[]})).rejects.toThrow('calling authority');
 const userId=await createAppUser(b.tenantId,first.personId,'employee'),self:SessionContext={tenantId:b.tenantId,userId,personId:first.personId,roles:['employee']};
 expect(choicesWithoutContext(await readEmployeeChoices(self,{companyIds:[zeta.id]}))).toEqual(choicePage([beta],[zeta],[shared]));
 await expect(readEmployeeChoices(self,{companyIds:[],labelMode:'labels'})).rejects.toThrow('administration access');
 await expect(readEmployeeChoices({...self,personId:randomUUID()},{companyIds:[]})).rejects.toThrow('calling authority');
 await setAppUserArchived(ctx,{appUserId:userId,archived:true});
 await expect(readEmployeeChoices(self,{companyIds:[]})).rejects.toThrow('calling authority');
},120000);

it('retains current Assignment facets across dates, native exclusion, archived labels and sparse borrowed scope',async()=>{
 const b=await seedBase(),ctx=adminCtx(b),acme={id:b.companyId,name:'Acme Sdn Bhd'};
 const [constraint]=await owner.client`select c.contype,c.condeferrable,c.convalidated,am.amname,
   pg_get_constraintdef(c.oid) as definition,pg_get_expr(i.indpred,i.indrelid) as predicate
   from pg_constraint c join pg_index i on i.indexrelid=c.conindid join pg_class x on x.oid=c.conindid
   join pg_am am on am.oid=x.relam where c.conrelid='public.assignment'::regclass and c.conname='assignment_no_overlap'`;
 expect(constraint).toMatchObject({contype:'x',condeferrable:false,convalidated:true,amname:'gist',predicate:'(superseded_at IS NULL)'});
 expect(constraint.definition).toContain("employment_id WITH =, daterange(valid_from, valid_to, '[)'::text) WITH &&");
 const obsolete=await createDepartment(ctx,{companyId:acme.id,name:'Facet Former'});
 const superseded=await createDepartment(ctx,{companyId:acme.id,name:'Facet Superseded'});
 const future=await hireEmployee(ctx,{person:{fullName:'Alpha Future',primaryEmail:'future-facet@example.invalid'},companyId:acme.id,departmentId:obsolete.id,employeeCode:'FACET-FUT',hiredOn:'2020-01-01',employmentType:'full_time'});
 const date='2099-01-01';
 expect(await setEmploymentAssignment(ctx,{employmentId:future.employmentId,departmentId:b.deptA,effectiveDate:date})).toMatchObject({changed:true});
 const [later]=await owner.db.select().from(assignment).where(eq(assignment.employmentId,future.employmentId)).then(rows=>rows.filter(row=>row.validTo===null));
 expect(later).toMatchObject({departmentId:b.deptA,validFrom:date,validTo:null,supersededAt:null});
 const [ended]=await owner.db.insert(employment).values({tenantId:b.tenantId,personId:future.personId,companyId:acme.id,hiredOn:'2020-01-01',terminatedOn:'2024-01-01',employeeCode:'FACET-ENDED'}).returning({id:employment.id});
 await owner.db.insert(assignment).values({tenantId:b.tenantId,employmentId:ended.id,companyId:acme.id,departmentId:b.deptB,validFrom:'2020-01-01',employmentType:'full_time'});
 await owner.db.insert(assignment).values({tenantId:b.tenantId,employmentId:ended.id,companyId:acme.id,departmentId:superseded.id,validFrom:'2020-01-01',employmentType:'full_time',supersededAt:new Date('2021-01-01T00:00:00Z')});
 const [unassignedPerson]=await owner.db.insert(person).values({tenantId:b.tenantId,fullName:'Zed Unassigned',primaryEmail:'no-facet@example.invalid'}).returning({id:person.id});
 const [unassigned]=await owner.db.insert(employment).values({tenantId:b.tenantId,personId:unassignedPerson.id,companyId:acme.id,hiredOn:'2020-01-01'}).returning({id:employment.id});
 const before=await owner.client`select id,department_id,valid_from,valid_to,superseded_at from assignment where employment_id=${future.employmentId}::uuid order by id`;
 await expect(owner.client.begin(tx=>tx`insert into assignment(tenant_id,employment_id,company_id,department_id,employment_type,valid_from)
   values(${b.tenantId}::uuid,${future.employmentId}::uuid,${acme.id}::uuid,${b.deptB}::uuid,'full_time',${date}::date)`))
  .rejects.toMatchObject({code:'23P01',constraint_name:'assignment_no_overlap'});
 expect(await owner.client`select id,department_id,valid_from,valid_to,superseded_at from assignment where employment_id=${future.employmentId}::uuid order by id`).toEqual(before);
 await archiveDepartment(ctx,{id:b.deptA,archived:true});
 const [archived]=await owner.db.select({date:department.archivedAt}).from(department).where(eq(department.id,b.deptA));expect(archived.date).not.toBeNull();
 await owner.db.update(department).set({label:'  Facet 人  '}).where(eq(department.id,b.deptA));
 await owner.db.update(department).set({label:'   ',description:'  Facet 人  '}).where(eq(department.id,b.deptB));
 const finance={id:b.deptA,name:'Finance'},operations={id:b.deptB,name:'Operations'};
 const active=choiceRow(future.employmentId,'Alpha Future','FACET-FUT',acme.id,acme.name,b.deptA,'Finance');
 const endedRow=choiceRow(ended.id,'Alpha Future','FACET-ENDED',acme.id,acme.name,b.deptB,'Operations','ended');
 const missing=choiceRow(unassigned.id,'Zed Unassigned',null,acme.id,acme.name,null,null);
 const ordered=[active,endedRow].sort((left,right)=>left.employmentId<right.employmentId?-1:1);
 const labelled=ordered.map(row=>({...row,department:'Facet 人',departmentCode:row.department}));
 expect(choicesWithoutContext(await readEmployeeChoices(ctx,{companyIds:[],labelMode:'labels'}))).toEqual(choicePage([...labelled,missing],[acme],
  [{id:b.deptA,name:'Facet 人 (Finance)'},{id:b.deptB,name:'Facet 人 (Operations)'}],{labelMode:'labels'}));
 await database.withTenant(ctx,async tx=>{
  const equality=await readEmployeeChoicesTx(tx,ctx,{companyIds:[acme.id],terminatedAfter:'2024-01-01'});
  expect(choicesWithoutContext(equality)).toEqual(choicePage([active,missing],[acme],[finance]));
  const sparse=await readEmployeeChoicesTx(tx,ctx,{companyIds:[acme.id],terminatedAfter:'2023-12-31',employmentIds:[ended.id]});
  expect(choicesWithoutContext(sparse)).toEqual(choicePage([endedRow],[acme],[operations]));
  expect(choicesWithoutContext(await readEmployeeChoicesTx(tx,ctx,{companyIds:[],employmentIds:[]}))).toEqual(choicePage([],[],[]));
  const past=await readEmployeeChoicesTx(tx,ctx,{companyIds:[acme.id],terminatedAfter:'2024-01-01',
   employmentIds:[future.employmentId,ended.id,unassigned.id],departmentId:b.deptA,offset:1,selectedId:unassigned.id});
  expect(choicesWithoutContext(past)).toEqual(choicePage([],[acme],[finance],{
   total:1,selected:missing,offset:1,filters:{...emptyFilters,departmentId:b.deptA},
  }));
  const denied=await readEmployeeChoicesTx(tx,ctx,{companyIds:[acme.id],terminatedAfter:'2024-01-01',
   employmentIds:[ended.id],departmentId:b.deptB,selectedId:ended.id});
  expect(choicesWithoutContext(denied)).toEqual(choicePage([],[],[],{filters:{...emptyFilters,departmentId:b.deptB}}));
 },{readOnlySnapshot:true});
},120000);

it('keeps manager and department hierarchy facets inside native effective reporting dates',async()=>{
 const b=await seedBase(),ctx=adminCtx(b),acme={id:b.companyId,name:'Acme Sdn Bhd'};
 const child=await createDepartment(ctx,{companyId:acme.id,name:'Facet Child',parentDepartmentId:b.deptA});
 const future=await createDepartment(ctx,{companyId:acme.id,name:'Facet Future'});
 const hire=async(name:string,departmentId:string,code:string)=>hireEmployee(ctx,{person:{fullName:name,primaryEmail:code.toLowerCase()+'@example.invalid'},
  companyId:acme.id,departmentId,employeeCode:code,hiredOn:'2020-01-01',employmentType:'full_time'});
 const manager=await hire('Alpha Manager',b.deptA,'FACET-MGR');
 const report=await hire('Beta Direct',b.deptB,'FACET-DIR');
 const hod=await hire('Gamma Department',child.id,'FACET-HOD');
 const outside=await hire('Zed Future',future.id,'FACET-LATE');
 await setReportingLine(ctx,{subordinateEmploymentId:report.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2020-01-01'});
 await setReportingLine(ctx,{subordinateEmploymentId:outside.employmentId,managerEmploymentId:manager.employmentId,lineType:'administrative',validFrom:'2099-01-01'});
 const userId=await createAppUser(b.tenantId,manager.personId,'manager');
 const actor:SessionContext={tenantId:b.tenantId,userId,personId:manager.personId,roles:['manager']};
 const departments=[{id:child.id,name:'Facet Child'},{id:b.deptA,name:'Finance'},{id:b.deptB,name:'Operations'}];
 expect(choicesWithoutContext(await readEmployeeChoices(actor,{companyIds:[],selectedId:outside.employmentId}))).toEqual(choicePage([
  choiceRow(manager.employmentId,'Alpha Manager','FACET-MGR',acme.id,acme.name,b.deptA,'Finance'),
  choiceRow(report.employmentId,'Beta Direct','FACET-DIR',acme.id,acme.name,b.deptB,'Operations'),
  choiceRow(hod.employmentId,'Gamma Department','FACET-HOD',acme.id,acme.name,child.id,'Facet Child'),
 ],[acme],departments));
},120000);

it('compares represented Department pairs under actual native scope and independent table denials',async()=>{
 const f=await createAssignmentAuthorityFixture(),{b,otherCompany,alpha,gamma,transferred,unassigned}=f;
 const dialect=new PgDialect(),tenantPairs=[[b.companyId,b.deptA],[b.companyId,b.deptB],[otherCompany,b.deptB]];
 const sorted=(rows:string[][])=>rows.map(row=>row.join('/')).sort();
 type Input=Parameters<typeof readEmployeeChoicesTx>[2];
 const read=async(tx:Tx,ctx:SessionContext,input:Input,replacement:boolean)=>{
  const capture:{original?:SQL;forwarded?:SQL;pairs?:string[][]}={};
  const proxy=new Proxy(tx,{get(target,key,receiver){
   if(key==='execute')return async(query:SQL)=>{
    const {sql:text,params}=dialect.sqlToQuery(query);
    if(!isDepartmentFacet(text.trimStart()))return target.execute(query);
    if(capture.original)throw new Error('Multiple native Department statements');
    capture.original=query;expect(params).toEqual(departmentFacetBinds(ctx.tenantId,input));
    const forwarded=replacement?representedDepartmentFacet(ctx.tenantId,input):query;
    capture.forwarded=forwarded;
    const rows=await target.execute<{companyId:string;departmentId:string}>(forwarded);
    capture.pairs=rows.map(row=>[row.companyId,row.departmentId]);return rows;
   };
   const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
  }});
  const page=await readEmployeeChoicesTx(proxy,ctx,input);
  const {original,forwarded,pairs}=capture;
  if(!original||!forwarded||!pairs)throw new Error('Missing forwarded native Department result');
  return {page,original:dialect.sqlToQuery(original),forwarded,pairs};
 };
 type HistoricalAssignment={id:string;employmentId:string;departmentId:string;validTo:string|null;supersededAt:Date|null};
 const compare=async(ctx:SessionContext,input:Input,total:number,pairs:string[][],visibility?:boolean[],history?:HistoricalAssignment)=>database.withTenant(ctx,async tx=>{
  await tx.execute(sql`set local lock_timeout='300ms'`);
  await tx.execute(sql`set local statement_timeout='3s'`);
  const [identity]=await tx.execute(sql`select current_user as role,session_user as login,
   app.current_tenant_id()::text as tenant,app.current_user_id()::text as actor,
   current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only') as read_only,
   (select not (rolsuper or rolbypassrls) from pg_roles where rolname=current_user) as limited,
   (select bool_and(row_security_active(c.oid)) and count(*)=5 from pg_class c where c.oid in
    ('public.assignment'::regclass,'public.employment'::regclass,'public.person'::regclass,'public.company'::regclass,'public.department'::regclass)) as rls`);
  expect(identity).toEqual({role:'ai_hr_app',login:'ai_hr_app',tenant:ctx.tenantId,actor:ctx.userId,isolation:'repeatable read',read_only:'on',limited:true,rls:true});
  const before=await read(tx,ctx,input,false),after=await read(tx,ctx,input,true);
  expect(after.original).toEqual(before.original);
  expect(choicesWithoutContext(after.page)).toEqual(choicesWithoutContext(before.page));
  expect(after.page.total).toBe(total);
  expect(sorted(before.pairs)).toEqual(sorted(pairs));expect(sorted(after.pairs)).toEqual(sorted(pairs));
  if(visibility){
   const [native]=await tx.execute(sql`select
    exists(select 1 from public.employment where id=${transferred.id}::uuid and tenant_id=${b.tenantId}::uuid) as e,
    exists(select 1 from public.person where id=${transferred.personId}::uuid and tenant_id=${b.tenantId}::uuid) as p,
    exists(select 1 from public.assignment where id=${transferred.assignmentId!}::uuid and tenant_id=${b.tenantId}::uuid) as a`);
   expect(native).toEqual({e:visibility[0],p:visibility[1],a:visibility[2]});
  }
  if(history){
   const rows=await tx.select({id:assignment.id,employmentId:assignment.employmentId,departmentId:assignment.departmentId,
    validTo:assignment.validTo,supersededAt:assignment.supersededAt}).from(assignment).where(eq(assignment.id,history.id));
   expect(rows).toEqual([history]);
  }
  if(input.employmentIds?.length===0){
   type EmptyPlan={'Relation Name'?:string;'Actual Loops':number;'Actual Rows':number;Plans?:EmptyPlan[]};
   const [row]=await tx.execute<{'QUERY PLAN':{Plan:EmptyPlan}[]}>(sql`explain(analyze,buffers,verbose,timing off,format json) ${after.forwarded}`);
   const check=(node:EmptyPlan)=>{
    if(node['Relation Name']==='assignment')expect(node['Actual Loops']).toBe(0);
    for(const child of node.Plans??[])check(child);
   };
   const root=row['QUERY PLAN'][0].Plan;expect(root['Actual Rows']).toBe(0);check(root);
  }
  return after.page;
 },{readOnlySnapshot:true});

 const [physical]=await owner.db.select({companyId:employment.companyId,origin:assignment.companyId,departmentId:assignment.departmentId})
  .from(employment).innerJoin(assignment,eq(assignment.employmentId,employment.id)).where(eq(assignment.id,transferred.assignmentId!));
 expect(physical).toEqual({companyId:otherCompany,origin:b.companyId,departmentId:b.deptB});
 await compare(f.ctx,{companyIds:[]},5,tenantPairs,[true,true,true]);
 await archiveDepartment(f.ctx,{id:b.deptA,archived:true});
 await owner.db.update(department).set({label:'  Paired 人  '}).where(eq(department.id,b.deptA));
 await owner.db.update(department).set({label:'   ',description:'  Paired 人  '}).where(eq(department.id,b.deptB));
 const narrowed=await compare(f.ctx,{companyIds:[],companyId:otherCompany,departmentId:b.deptA,businessUnitId:f.unit,query:'absent',
  status:'active',labelMode:'labels',limit:1,offset:20,selectedId:unassigned.id},0,tenantPairs);
 expect(narrowed.selected?.employmentId).toBe(unassigned.id);
 expect(narrowed.departmentOptions).toEqual([{id:b.deptB,name:'Paired 人'}]);
 expect(narrowed.allDepartmentOptions).toEqual([{id:b.deptA,name:'Paired 人 (Finance)'},{id:b.deptB,name:'Paired 人 (Operations)'}]);
 const limited=[alpha.id,transferred.id,...Array.from({length:23},()=>randomUUID())];
 const limitedPairs=[[b.companyId,b.deptA],[otherCompany,b.deptB]];
 await compare(f.ctx,{companyIds:[],employmentIds:limited},2,limitedPairs);
 await compare(f.ctx,{companyIds:[],employmentIds:[...limited,alpha.id]},2,limitedPairs);
 await compare(f.ctx,{companyIds:[],employmentIds:[]},0,[]);
 const closed={id:f.closedUnassigned,employmentId:unassigned.id,departmentId:b.deptA,validTo:'2021-01-01',supersededAt:null};
 await compare(f.ctx,{companyIds:[b.companyId],employmentIds:[unassigned.id]},1,[],undefined,closed);
 // Alpha has a current Finance row and a superseded Operations row with a NULL end.
 try{
  const changed=await owner.db.update(assignment).set({validTo:null}).where(eq(assignment.id,f.supersededAlpha)).returning({id:assignment.id});
  expect(changed).toEqual([{id:f.supersededAlpha}]);
  await compare(f.ctx,{companyIds:[b.companyId],employmentIds:[alpha.id]},1,[[b.companyId,b.deptA]],undefined,
   {id:f.supersededAlpha,employmentId:alpha.id,departmentId:b.deptB,validTo:null,supersededAt:new Date('2022-01-01T00:00:00Z')});
 }finally{await owner.db.update(assignment).set({validTo:'2021-01-01'}).where(eq(assignment.id,f.supersededAlpha));}
 await compare(f.scopedCtx,{companyIds:[otherCompany]},0,[]);
 await compare(f.managerCtx,{companyIds:[b.companyId]},2,tenantPairs.slice(0,2));
 await compare(f.selfCtx,{companyIds:[otherCompany],employmentIds:[transferred.id,transferred.id]},1,[[otherCompany,b.deptB]]);
 await compare(adminCtx(f.foreign),{companyIds:[b.companyId],employmentIds:[alpha.id]},0,[]);
 for(const partner of f.partners){
  await compare(partner,{companyIds:[otherCompany]},1,[],[true,true,false]);
  await compare(partner,{companyIds:[otherCompany],employmentIds:[transferred.id]},1,[],[true,true,false]);
 }

 await owner.db.update(person).set({voidedAt:new Date()}).where(eq(person.id,transferred.personId));
 try{
  await compare(f.ctx,{companyIds:[otherCompany]},0,[],[true,false,true]);
  await compare(f.ctx,{companyIds:[otherCompany],employmentIds:[transferred.id]},0,[],[true,false,true]);
 }finally{await owner.db.update(person).set({voidedAt:null}).where(eq(person.id,transferred.personId));}
 await owner.db.update(employment).set({terminatedOn:'2024-01-01'}).where(eq(employment.id,gamma.id));
 try{
  await compare(f.ctx,{companyIds:[b.companyId],employmentIds:[gamma.id],terminatedAfter:'2024-01-01'},0,[]);
  await compare(f.ctx,{companyIds:[b.companyId],employmentIds:[gamma.id],terminatedAfter:'2023-12-31'},1,[[b.companyId,b.deptA]]);
 }finally{await owner.db.update(employment).set({terminatedOn:null}).where(eq(employment.id,gamma.id));}
 const grant=await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,f.employeeUser)).returning();
 try{
  expect(grant).toHaveLength(1);
  await database.withTenant(f.employeeCtx,async tx=>{
   await expect(read(tx,f.employeeCtx,{companyIds:[]},false)).rejects.toThrow('calling authority');
   await expect(read(tx,f.employeeCtx,{companyIds:[]},true)).rejects.toThrow('calling authority');
  },{readOnlySnapshot:true});
 }finally{if(grant.length)await owner.db.insert(roleAssignment).values(grant);}
},120000);
