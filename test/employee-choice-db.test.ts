import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq,sql,type SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import {readEmployeeChoices} from '../core/employee-choice';
import {listEmployees} from '../core/read';
import {hireEmployee} from '../core/org';
import {assignment,businessUnit,company,department,employment,person,reportingLine,roleAssignment} from '../db/schema';
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
 expect(first.total).toBe(names.length);expect(first.rows.map(row=>row.employmentId)).toEqual(legacy.slice(0,25).map(row=>row.employmentId));
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
 const report:Record<string,unknown>={kind:'NATIVE_EMPLOYEE_CHOICE_COMPONENT_ONLY',releaseEligible:false,employees:50000};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'employee-choice-50k.json'),JSON.stringify(report,null,2));};
 report.policies=await owner.client`select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public' and tablename in ('employment','person','assignment','company','department','business_unit') order by tablename,policyname`;save();
 const {b,ctx,expectedFirst,expectedLast}=await seedPersonnelNativeFixture(50000,report,name=>{report.phase=name;save();},save);
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
 report.timings=timings;report.maxPageRows=Math.max(first.rows.length,deep.rows.length,found.rows.length);report.exactNativeIdsAndCounts=true;save();
 }finally{spy.mockRestore();save();}
},300000);

it('stops further SQL after a disconnected count and releases the native transaction',async()=>{
 const b=await seedBase(),ctx=adminCtx(b),controller=new AbortController(),stop=Error('Controlled choice disconnect');
 const actual=database.withTenant;let afterAbort=0,sawCount=false;
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(context,tx=>read(new Proxy(tx,{
  get(target,key,receiver){
   if(key==='execute')return async(...args:unknown[])=>{
    if(controller.signal.aborted)afterAbort++;
    const result=await Reflect.apply(target.execute,target,args);
    if(Array.isArray(result)&&result[0]&&typeof result[0].total==='number'){sawCount=true;controller.abort(stop);}
    return result;
   };
   const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
  },
 })),options));
 try{await expect(readEmployeeChoices(ctx,{companyIds:[b.companyId]},controller.signal)).rejects.toBe(stop);}
 finally{spy.mockRestore();}
 expect(sawCount).toBe(true);expect(afterAbort).toBe(0);
 expect((await readEmployeeChoices(ctx,{companyIds:[b.companyId]})).total).toBe(0);
});
