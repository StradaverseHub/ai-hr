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
import {hireEmployee,setEmploymentAssignment,setReportingLine} from '../core/org';
import {archiveDepartment,assignRole,createCompany,createDepartment,revokeRole} from '../core/admin';
import {setAppUserArchived} from '../core/auth';
import {setLabelCriteria} from '../core/system-labels';
import {appUser,assignment,businessUnit,company,department,employment,labelCompanyAssignment,person,reportingLine,roleAssignment} from '../db/schema';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';
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
