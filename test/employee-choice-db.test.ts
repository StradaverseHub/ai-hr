import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {availableParallelism,cpus,totalmem} from 'node:os';
import {eq,sql,type SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {readEmployeeChoices,readEmployeeChoicesTx} from '../core/employee-choice';
import {isEmployeeChoicePage,type EmployeeChoice,type EmployeeChoicePage} from '../lib/employee-choice';
import {listEmployees} from '../core/read';
import {rosterPopulationReview,rosterWindowPage} from '../core/roster-presentation';
import {hireEmployee,setEmploymentAssignment,setReportingLine} from '../core/org';
import {archiveDepartment,assignRole,createCompany,createDepartment,revokeRole} from '../core/admin';
import {setAppUserArchived} from '../core/auth';
import {setLabelCriteria} from '../core/system-labels';
import {appUser,assignment,businessUnit,company,department,employment,labelCompanyAssignment,person,reportingLine,roleAssignment} from '../db/schema';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';
import {createAssignmentAuthorityFixture} from './performance/employee-choice-assignment-authority';
import {firstWitnessDepartmentFacet,isDepartmentFacet,isSparseDepartmentFacet,sparseDepartmentFacetBinds} from './performance/employee-choice-department-pair-probe';
beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(resetDb);

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

it('pages the real 50k population without retaining whole employee DTOs or losing deep selection',async()=>{
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
},300000);

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
 try{
  const input={companyIds:[b.companyId]};
  if(mode==='count'){
   const filtered={...input,departmentId:b.deptA};
   const first=await readEmployeeChoices(ctx,filtered,controller.signal);
   expect(first).toMatchObject({rows:[],total:0});
   expect(sawRead).toBe(false);
   await expect(readEmployeeChoices(ctx,{...filtered,offset:1},controller.signal)).rejects.toBe(stop);
  }else{
   await expect(readEmployeeChoices(ctx,{...input,query:'cancelled 人 search'},controller.signal)).rejects.toBe(stop);
  }
 }
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

it('compares product sparse Department pairs with the first witness under native scope and independent denials',async()=>{
 const f=await createAssignmentAuthorityFixture(),{b,otherCompany,alpha,gamma,transferred,unassigned}=f;
 const dialect=new PgDialect(),tenantPairs=[[b.companyId,b.deptA],[b.companyId,b.deptB],[otherCompany,b.deptB]];
 const sorted=(rows:string[][])=>rows.map(row=>row.join('/')).sort();
 type Input=Parameters<typeof readEmployeeChoicesTx>[2];
 const read=async(tx:Tx,ctx:SessionContext,input:Input,baseline:boolean)=>{
  const capture:{original?:SQL;forwarded?:SQL;pairs?:string[][]}={};
  const proxy=new Proxy(tx,{get(target,key,receiver){
   if(key==='execute')return async(query:SQL)=>{
    const compiled=dialect.sqlToQuery(query),text=compiled.sql.trimStart();
    const sparse=isSparseDepartmentFacet(text);
    if(!sparse&&!isDepartmentFacet(text))return target.execute(query);
    if(capture.original)throw new Error('Multiple native Department statements');
    const populationSize=input.employmentIds?.length??0;
    expect(sparse).toBe(populationSize>0&&populationSize<=25);
    const reference=firstWitnessDepartmentFacet(ctx.tenantId,input);
    if(sparse)expect(compiled.params).toEqual(sparseDepartmentFacetBinds(ctx.tenantId,input));
    else expect(compiled).toEqual(dialect.sqlToQuery(reference));
    capture.original=query;
    const forwarded=baseline?reference:query;
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
  const before=await read(tx,ctx,input,true),after=await read(tx,ctx,input,false);
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
 const sparseLabels=await compare(f.ctx,{companyIds:[],employmentIds:limited,companyId:otherCompany,labelMode:'labels',selectedId:gamma.id},1,limitedPairs);
 expect(sparseLabels.selected).toBeNull();
 expect(sparseLabels.departmentOptions).toEqual([{id:b.deptB,name:'Paired 人'}]);
 expect(sparseLabels.allDepartmentOptions).toEqual([{id:b.deptA,name:'Paired 人 (Finance)'},{id:b.deptB,name:'Paired 人 (Operations)'}]);
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
 await compare(f.scopedCtx,{companyIds:[otherCompany],employmentIds:[transferred.id]},0,[]);
 await compare(f.managerCtx,{companyIds:[b.companyId]},2,tenantPairs.slice(0,2));
 await compare(f.managerCtx,{companyIds:[b.companyId],employmentIds:[alpha.id,gamma.id]},1,[[b.companyId,b.deptA]]);
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
 const editScope={companyIds:[b.companyId],employmentIds:[gamma.id],from:'2027-01-04',to:'2027-01-10',offset:0,limit:1};
 await owner.db.update(employment).set({terminatedOn:'2024-01-01'}).where(eq(employment.id,gamma.id));
 try{
  await compare(f.ctx,{companyIds:[b.companyId],employmentIds:[gamma.id],terminatedAfter:'2024-01-01'},0,[]);
  await compare(f.ctx,{companyIds:[b.companyId],employmentIds:[gamma.id],terminatedAfter:'2023-12-31'},1,[[b.companyId,b.deptA]]);
  const endedEdit=await rosterWindowPage(f.ctx,editScope);
  expect(endedEdit).toMatchObject({total:0,employees:[],departmentOptions:[]});
 }finally{await owner.db.update(employment).set({terminatedOn:null}).where(eq(employment.id,gamma.id));}
 const activeEdit=await rosterWindowPage(f.ctx,editScope);
 expect(activeEdit.total).toBe(1);
 expect(activeEdit.employees.map(row=>row.employmentId)).toEqual([gamma.id]);
 expect(activeEdit.departmentOptions).toEqual([{id:b.deptA,name:'Paired 人'}]);
 const prepared=await rosterPopulationReview(f.ctx,{companyIds:[b.companyId],employmentIds:[alpha.id,gamma.id]});
 expect(prepared.ids).toEqual([alpha.id,gamma.id]);
 expect(prepared.page).toMatchObject({total:2,rows:[{employmentId:alpha.id},{employmentId:gamma.id}]});
 if(!('departmentOptions' in prepared.page))throw new Error('Missing ordinary roster review page');
 expect(prepared.page.departmentOptions).toEqual([{id:b.deptA,name:'Paired 人'}]);
 const grant=await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,f.employeeUser)).returning();
 try{
  expect(grant).toHaveLength(1);
  await database.withTenant(f.employeeCtx,async tx=>{
   await expect(read(tx,f.employeeCtx,{companyIds:[]},false)).rejects.toThrow('calling authority');
   await expect(read(tx,f.employeeCtx,{companyIds:[]},true)).rejects.toThrow('calling authority');
   await expect(read(tx,f.employeeCtx,{companyIds:[],employmentIds:[alpha.id]},false)).rejects.toThrow('calling authority');
  },{readOnlySnapshot:true});
 }finally{if(grant.length)await owner.db.insert(roleAssignment).values(grant);}
},120000);
