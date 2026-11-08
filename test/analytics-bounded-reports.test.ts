import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {eq,inArray,sql,type SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {assignment,company,department,employment,leaveLedger,leaveType,person,position,roleAssignment} from '../db/schema';
import {hireEmployee,terminateEmployment,transferEmployee} from '../core/org';
import {
 analyticsManagerSelection,carryForwardReport,carryForwardReportPage,changeJobTransactions,changeJobTransactionsPage,
 headcountSummary,masterDataCount,masterDataExport,newHires,newHiresPage,terminations,terminationsPage,
} from '../core/analytics';
import * as templates from '../core/entitlement-template';
import {parsePageQuery} from '../lib/pagination';
import {pgSqlState} from '../lib/db-error';
import {observeNativeRead} from './helpers/native-read-observer';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

beforeAll(migrateTestDb);beforeEach(async()=>{carryBoundaryScope?.refuseUnsettled();await resetDb();});afterAll(async()=>{carryBoundaryScope?.refuseUnsettled();await closeAll();});
const period={from:'2020-01-01',to:'2026-12-31'};
const first=parsePageQuery();
async function seedRows(b:Base,n:number,p:{terminatedOn?:string;name?:(i:number)=>string;hiredOn?:string}={},owned?:{tx:Tx;scope:CarryBoundaryScope}){
 const ids:string[]=[],people:string[]=[];
 for(let offset=0;offset<n;offset+=500){
  const indices=Array.from({length:Math.min(500,n-offset)},(_,i)=>offset+i);
  const personRows=indices.map(i=>({id:randomUUID(),tenantId:b.tenantId,fullName:p.name?.(i)??`Fictional report ${String(i).padStart(5,'0')}`,primaryEmail:randomUUID()+'@example.invalid'}));
  const employmentRows=personRows.map(row=>({id:randomUUID(),tenantId:b.tenantId,personId:row.id,companyId:b.companyId,hiredOn:p.hiredOn??'2020-01-01',terminatedOn:p.terminatedOn??null}));
  owned?.scope.check();const target=owned?.tx??owner.db;
  await target.insert(person).values(personRows);
  await target.insert(employment).values(employmentRows);
  await target.insert(assignment).values(employmentRows.map(row=>({tenantId:b.tenantId,employmentId:row.id,companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time' as const,validFrom:row.hiredOn})));
  ids.push(...employmentRows.map(row=>row.id));people.push(...personRows.map(row=>row.id));
  owned?.scope.event('seed-batch-return',{rows:indices.length});
 }
 return {ids,people};
}

it('keeps event-date departments, inclusive termination ends and canonical predecessor corrections',async()=>{
 const b=await seedBase(),ctx=adminCtx(b);
 const employee=await hireEmployee(ctx,{person:{fullName:'Fictional temporal report',primaryEmail:'temporal-report@example.invalid'},companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 const moved=await transferEmployee(ctx,{employmentId:employee.employmentId,effectiveDate:'2021-05-01',departmentId:b.deptB});
 await terminateEmployment(ctx,{employmentId:employee.employmentId,terminationDate:'2022-06-01',terminationType:'voluntary'});
 const hired=await newHiresPage(ctx,[b.companyId],{...period,filter:{departmentId:b.deptA},page:first});
 expect(hired.rows).toEqual([{name:'Fictional temporal report',company:'Acme Sdn Bhd',department:'Finance',position:null,hiredOn:'2020-01-01'}]);
 expect(hired.state.total).toBe(1);
 expect((await newHiresPage(ctx,[b.companyId],{...period,filter:{departmentId:b.deptB},page:first})).state.total).toBe(0);
 const ended=await terminationsPage(ctx,[b.companyId],{...period,filter:{departmentId:b.deptB},page:first});
 expect(ended.rows).toEqual([{name:'Fictional temporal report',company:'Acme Sdn Bhd',department:'Operations',terminatedOn:'2022-06-01',terminationType:'voluntary',terminationReason:null}]);
 for(const departmentId of [b.deptA,b.deptB]){
  const movedPage=await changeJobTransactionsPage(ctx,[b.companyId],{...period,filter:{departmentId},page:first});
  expect(movedPage.state.total).toBe(1);
  expect(movedPage.rows[0]).toMatchObject({fromDepartment:'Finance',toDepartment:'Operations',effectiveOn:'2021-05-01'});
  expect(movedPage.rows).toEqual(await changeJobTransactions(ctx,[b.companyId],{...period,filter:{departmentId}}));
 }
 await owner.db.update(assignment).set({supersededAt:new Date()}).where(eq(assignment.id,moved.assignmentId));
 expect((await changeJobTransactionsPage(ctx,[b.companyId],{...period,page:first})).rows).toEqual([]);
});

it('preserves SQL wildcard/name/email matching and returns string dates with export-compatible DTOs',async()=>{
 const b=await seedBase(),ctx=adminCtx(b);await seedRows(b,3);
 const query={...period,filter:{q:'%'},page:first};
 expect((await newHiresPage(ctx,[],query)).rows).toEqual(await newHires(ctx,[],query));
 expect((await newHiresPage(ctx,[],{...query,filter:{q:'example.invalid'}})).state.total).toBe(3);
 expect((await newHiresPage(ctx,[],{...query,filter:{q:'Fictional report 0000_'}})).state.total).toBe(3);
 const result=await newHiresPage(ctx,[],query);
 expect(JSON.parse(JSON.stringify(result)).rows).toEqual(result.rows);
 expect(result.rows.every(row=>typeof row.hiredOn==='string')).toBe(true);
 const none=await newHiresPage(ctx,[],{...query,filter:{q:'Definitely absent'}});
 expect(none.rows).toEqual([]);expect(none.state).toMatchObject({total:0,from:0,to:0,hasNext:false});
 const beyond=await newHiresPage(ctx,[],{...query,page:parsePageQuery({page:'9'})});
 expect(beyond.rows).toEqual([]);expect(beyond.state).toMatchObject({total:3,from:0,to:0,hasPrev:true});
});

it('counts and pages the full population beyond the shared All ceiling while exports remain complete',async()=>{
 const b=await seedBase(),ctx=adminCtx(b);await seedRows(b,2052);
 const all=await newHiresPage(ctx,[b.companyId],{...period,page:parsePageQuery({size:'all'})});
 expect(all.rows).toHaveLength(2000);expect(all.state).toMatchObject({total:2052,truncated:true,from:1,to:2000});
 expect(all.rows[0].name).toBe('Fictional report 00000');expect(all.rows.at(-1)?.name).toBe('Fictional report 01999');
 const deep=await newHiresPage(ctx,[b.companyId],{...period,page:parsePageQuery({page:'82'})});
 expect(deep.rows.map(row=>row.name)).toEqual(['Fictional report 02050','Fictional report 02051']);
 expect(deep.state.total).toBe(2052);
 expect(await newHires(ctx,[b.companyId],period)).toHaveLength(2052);
 expect(await masterDataCount(ctx,[b.companyId])).toBe(2052);
 expect(await masterDataExport(ctx,[b.companyId])).toHaveLength(2052);
 await expect(newHiresPage(ctx,[b.companyId],{...period,page:{...first,limit:2052}})).rejects.toThrow('Invalid analytics page');
},120000);

it('keeps native tenant/company RLS, selected identities outside page and current calling authority',async()=>{
 const b=await seedBase(),ctx=adminCtx(b),{ids,people}=await seedRows(b,30);
 const foreign=await seedBase(),foreignRow=await seedRows(foreign,1);
 const [otherCompany]=await owner.db.insert(company).values({tenantId:b.tenantId,legalName:'Fictional other company'}).returning({id:company.id});
 const otherPerson=randomUUID(),otherEmployment=randomUUID();
 await owner.db.insert(person).values({id:otherPerson,tenantId:b.tenantId,fullName:'Fictional other company person',primaryEmail:otherPerson+'@example.invalid'});
 await owner.db.insert(employment).values({id:otherEmployment,tenantId:b.tenantId,personId:otherPerson,companyId:otherCompany.id,hiredOn:'2020-01-01'});
 const user=await createAppUser(b.tenantId,null,'hr_admin');
 await owner.db.update(roleAssignment).set({companyId:b.companyId}).where(eq(roleAssignment.appUserId,user));
 const scoped:SessionContext={tenantId:b.tenantId,userId:user,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:b.companyId}]};
 expect((await newHiresPage(scoped,[],{...period,page:first})).state.total).toBe(30);
 expect(await masterDataCount(scoped,[])).toBe(30);
 expect(await analyticsManagerSelection(scoped,[],ids[29])).toEqual({employmentId:ids[29],name:'Fictional report 00029'});
 expect(await analyticsManagerSelection(scoped,[],otherEmployment)).toBeNull();
 expect(await analyticsManagerSelection(ctx,[],foreignRow.ids[0])).toBeNull();
 expect(await analyticsManagerSelection(ctx,[otherCompany.id],ids[0])).toBeNull();
 expect(await analyticsManagerSelection(ctx,[],otherEmployment)).toEqual({employmentId:otherEmployment,name:'Fictional other company person'});
 expect(await analyticsManagerSelection(ctx,[],'malformed')).toBeNull();
 const employeeUser=await createAppUser(b.tenantId,people[0],'employee');
 const employeeCtx:SessionContext={tenantId:b.tenantId,userId:employeeUser,personId:people[0],roles:['employee']};
 expect((await newHiresPage(employeeCtx,[],{...period,page:first})).rows.map(row=>row.name)).toEqual(['Fictional report 00000']);
 await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,user));
 for(const read of [()=>newHiresPage(scoped,[],{...period,page:first}),()=>terminationsPage(scoped,[],{...period,page:first}),()=>changeJobTransactionsPage(scoped,[],{...period,page:first}),()=>carryForwardReportPage(scoped,[],{year:2026,page:first}),()=>masterDataCount(scoped,[]),()=>analyticsManagerSelection(scoped,[],ids[0])]){
  await expect(read()).rejects.toThrow('calling authority');
 }
});

it('groups the unchanged headcount source, coalescing null with literal em dash but retaining empty labels and future open assignments',async()=>{
 const b=await seedBase(),ctx=adminCtx(b),rows=await seedRows(b,4);
 const [dash,empty]=await owner.db.insert(department).values([{tenantId:b.tenantId,companyId:b.companyId,name:'—'},{tenantId:b.tenantId,companyId:b.companyId,name:''}]).returning({id:department.id});
 await owner.db.delete(assignment).where(eq(assignment.employmentId,rows.ids[0]));
 await owner.db.update(assignment).set({departmentId:dash.id}).where(eq(assignment.employmentId,rows.ids[1]));
 await owner.db.update(assignment).set({departmentId:empty.id}).where(eq(assignment.employmentId,rows.ids[2]));
 await owner.db.update(assignment).set({departmentId:b.deptB,validFrom:'2030-01-01'}).where(eq(assignment.employmentId,rows.ids[3]));
 // Headcount historically does not join Person. A hidden Person must not silently
 // change its existing employment population when moving aggregation into SQL.
 await owner.db.update(person).set({voidedAt:new Date()}).where(eq(person.id,rows.people[0]));
 const result=await headcountSummary(ctx,[b.companyId],{asOf:'2026-01-01'});
 expect(result.total).toBe(4);
 expect(result.byDepartment).toEqual([{name:'—',count:2},{name:'',count:1},{name:'Operations',count:1}]);
 expect(result.byCompany).toEqual([{name:'Acme Sdn Bhd',count:4}]);
 expect(result.byPosition).toEqual([{name:'—',count:4}]);
 expect(await headcountSummary(ctx,[b.companyId],{asOf:'2010-01-01'})).toEqual({total:0,byCompany:[],byDepartment:[],byPosition:[]});
});

it('uses one real RR/READ ONLY app transaction and completes behind an Access writer without audit writes',async()=>{
 const b=await seedBase(),ctx=adminCtx(b),{ids}=await seedRows(b,1);
 const [before]=await owner.client`select count(*)::int as count from domain_event where tenant_id=${b.tenantId}::uuid`;
 const actual=database.withTenant,observed:{role:string;isolation:string;readOnly:boolean;pid:number}[]=[];
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(context,async tx=>{
  const [properties]=await tx.execute<{role:string;isolation:string;readOnly:boolean;pid:number}>(sql`select current_user as role,current_setting('transaction_isolation')as isolation,current_setting('transaction_read_only')='on'as "readOnly",pg_backend_pid() as pid`);
  observed.push(properties);return read(tx);
 },options));
 try{
  await owner.client.begin(async writer=>{
   await writer`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`;
   expect((await newHiresPage(ctx,[],{...period,page:first})).state.total).toBe(1);
   expect((await terminationsPage(ctx,[],{...period,page:first})).state.total).toBe(0);
   expect((await changeJobTransactionsPage(ctx,[],{...period,page:first})).state.total).toBe(0);
   expect((await carryForwardReportPage(ctx,[],{year:2026,page:first})).state.total).toBe(1);
   expect(await masterDataCount(ctx,[])).toBe(1);
   expect(await analyticsManagerSelection(ctx,[],ids[0])).toMatchObject({employmentId:ids[0]});
  });
  expect(observed).toHaveLength(6);
  expect(observed.every(row=>row.role==='ai_hr_app'&&row.isolation==='repeatable read'&&row.readOnly===true&&row.pid>0)).toBe(true);
 }finally{spy.mockRestore();}
 const [after]=await owner.client`select count(*)::int as count from domain_event where tenant_id=${b.tenantId}::uuid`;
 expect(after).toEqual(before);
 const writeProbe=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(context,async tx=>{
  await tx.update(company).set({legalName:'Must not persist'}).where(eq(company.id,b.companyId));
  return read(tx);
 },options));
 try{
  let failure:unknown;
  try{await masterDataCount(ctx,[]);}catch(error){failure=error;}
  const messages:string[]=[];
  while(failure instanceof Error){messages.push(failure.message);failure=(failure as Error&{cause?:unknown}).cause;}
  expect(messages.join(' | ')).toMatch(/read-only transaction/i);
 }finally{writeProbe.mockRestore();}
 expect((await owner.db.select({name:company.legalName}).from(company).where(eq(company.id,b.companyId)))[0].name).toBe('Acme Sdn Bhd');
});

it('retains calendar/anniversary year population, leavers, leap hires and exact locale order before carry calculations',async()=>{
 const b=await seedBase(),ctx=adminCtx(b);
 const names=['éclair','Eclair','Ångström','Zulu','同名','同名',...Array.from({length:30},(_,i)=>'Fictional carry '+String(i).padStart(3,'0'))];
 const seeded=await seedRows(b,names.length,{name:i=>names[i],hiredOn:'2024-02-29'});
 const oldLeaver=seeded.ids[0],yearLeaver=seeded.ids[1],future=seeded.ids[2];
 await owner.db.update(employment).set({terminatedOn:'2025-12-31'}).where(eq(employment.id,oldLeaver));
 await owner.db.update(employment).set({terminatedOn:'2026-01-01'}).where(eq(employment.id,yearLeaver));
 await owner.db.update(employment).set({hiredOn:'2027-01-01'}).where(eq(employment.id,future));
 for(const cycle of ['calendar','anniversary'] as const){
  await owner.db.update(company).set({leaveCycle:cycle}).where(eq(company.id,b.companyId));
  const full=await carryForwardReport(ctx,[b.companyId],{year:2026});
  expect(full).toHaveLength(names.length-2);
  expect(full.some(row=>row.employmentId===yearLeaver)).toBe(true);
  expect(full.some(row=>row.employmentId===oldLeaver||row.employmentId===future)).toBe(false);
  expect(full.every(row=>row.cycleStart===(cycle==='calendar'?'2026-01-01':'2026-02-01'))).toBe(true);
  const page1=await carryForwardReportPage(ctx,[b.companyId],{year:2026,page:first});
  const page2=await carryForwardReportPage(ctx,[b.companyId],{year:2026,page:parsePageQuery({page:'1'})});
  expect([...page1.rows,...page2.rows]).toEqual(full);
  expect(page1.state.total).toBe(full.length);expect(page2.state.total).toBe(full.length);
  expect((await carryForwardReportPage(ctx,[b.companyId],{year:2026,page:parsePageQuery({page:'99'})})).state).toMatchObject({total:full.length,from:0,to:0});
 }
 await owner.db.update(leaveType).set({archivedAt:new Date()}).where(eq(leaveType.id,b.annualLeaveTypeId));
 expect((await carryForwardReportPage(ctx,[],{year:2026,page:first})).state.total).toBe(names.length-2);
 await owner.db.update(leaveType).set({code:'NOT_ANNUAL'}).where(eq(leaveType.id,b.annualLeaveTypeId));
 expect(await carryForwardReportPage(ctx,[],{year:2026,page:first})).toMatchObject({rows:[],state:{total:0}});
});

it('keeps per-employee entitlement eligibility and calculates only selected carry rows',async()=>{
 const b=await seedBase(),ctx=adminCtx(b),{ids}=await seedRows(b,40);
 await owner.db.update(assignment).set({departmentId:b.deptB}).where(inArray(assignment.employmentId,ids.slice(20)));
 for(const [name,departmentId,carryForwardDays] of [['Finance carry',b.deptA,2],['Operations carry',b.deptB,5]] as const){
  const template=await templates.createEntitlementTemplate(ctx,{leaveTypeId:b.annualLeaveTypeId,name,
   serviceBands:[{fromYears:0,toYears:null,days:12,carryForwardDays}],validFrom:'2020-01-01'});
  await templates.createEligibilityRule(ctx,{name,templateLineageId:template.lineageId,criteria:{departmentIds:[departmentId]},validFrom:'2020-01-01'});
 }
 await owner.db.insert(leaveLedger).values(ids.map(employmentId=>({tenantId:b.tenantId,employmentId,leaveTypeId:b.annualLeaveTypeId,entryType:'accrual' as const,days:'6.00',effectiveOn:'2025-12-31'})));
 const full=await carryForwardReport(ctx,[b.companyId],{year:2026});
 expect(full).toHaveLength(40);
 expect(full.slice(0,20).map(row=>row.carried)).toEqual(Array(20).fill(2));
 expect(full.slice(20).map(row=>row.carried)).toEqual(Array(20).fill(5));
 const actual=templates.buildTemplateEntitlementResolver,selectedBatches:string[][]=[];
 const spy=vi.spyOn(templates,'buildTemplateEntitlementResolver').mockImplementation((tx,p)=>{selectedBatches.push(p.employmentIds.slice());return actual(tx,p);});
 try{
  const page=await carryForwardReportPage(ctx,[b.companyId],{year:2026,page:first});
  expect(page.rows).toEqual(full.slice(0,25));expect(page.state.total).toBe(40);
  expect(selectedBatches).toHaveLength(1);expect(selectedBatches[0].slice().sort()).toEqual(page.rows.map(row=>row.employmentId).sort());
 }finally{spy.mockRestore();}
});


it('uses one materialized exact-count envelope for empty, tied first/last and past-end change-job pages',async()=>{
 const b=await seedBase(),ctx=adminCtx(b),query={from:'2021-01-01',to:'2021-12-31'};
 const emptyProbe=observeNativeRead();
 try{
  const empty=await changeJobTransactionsPage(ctx,[],{...query,page:first});
  expect(empty.rows).toEqual([]);expect(empty.state).toMatchObject({total:0,from:0,to:0,hasNext:false});
 }finally{emptyProbe.restore();}
 const emptyStatements=emptyProbe.queries.filter(row=>row.sql.includes('analytics_changeJobTransactions_page'));
 expect(emptyStatements).toHaveLength(1);expect(emptyStatements[0].rows).toBe(1);
 expect(emptyStatements[0].sql.match(/ as materialized /gi)).toHaveLength(1);
 expect(emptyStatements[0].sql.match(/inner join "assignment" "prior_assignment"/g)).toHaveLength(1);
 const {ids}=await seedRows(b,28,{name:i=>i===27?'Fictional earlier change':'Fictional tied change'});
 const positions=await owner.db.insert(position).values(ids.map((_,i)=>({tenantId:b.tenantId,companyId:b.companyId,title:'Fictional position '+String(i).padStart(2,'0')}))).returning({id:position.id,title:position.title});
 const expected:{employmentId:string;assignmentId:string;name:string;effectiveOn:string;toPosition:string}[]=[];
 for(const [i,id]of ids.entries()){
  const effectiveOn=i===26?'2021-01-01':'2021-12-31';
  await owner.db.update(assignment).set({validTo:effectiveOn}).where(eq(assignment.employmentId,id));
  const successorId=randomUUID();
  await owner.db.insert(assignment).values({id:successorId,tenantId:b.tenantId,employmentId:id,companyId:b.companyId,departmentId:b.deptB,positionId:positions[i].id,employmentType:'full_time',validFrom:effectiveOn});
  expected.push({employmentId:id,assignmentId:successorId,name:i===27?'Fictional earlier change':'Fictional tied change',effectiveOn,toPosition:positions[i].title});
 }
 expected.sort((a,b)=>b.effectiveOn.localeCompare(a.effectiveOn)||a.name.localeCompare(b.name)||a.employmentId.localeCompare(b.employmentId)||a.assignmentId.localeCompare(b.assignmentId));
 const expectedRows=expected.map(({name,effectiveOn,toPosition})=>({name,company:'Acme Sdn Bhd',fromDepartment:'Finance',toDepartment:'Operations',fromPosition:null,toPosition,effectiveOn}));
 const probe=observeNativeRead();
 try{
  const page1=await changeJobTransactionsPage(ctx,[b.companyId],{...query,page:first});
  const page2=await changeJobTransactionsPage(ctx,[b.companyId],{...query,page:parsePageQuery({page:'1'})});
  const beyond=await changeJobTransactionsPage(ctx,[b.companyId],{...query,page:parsePageQuery({page:'2'})});
  expect(page1.rows).toEqual(expectedRows.slice(0,25));expect(page1.state).toMatchObject({total:28,from:1,to:25,hasNext:true});
  expect(page2.rows).toEqual(expectedRows.slice(25));expect(page2.state).toMatchObject({total:28,from:26,to:28,hasNext:false,hasPrev:true});
  expect(beyond.rows).toEqual([]);expect(beyond.state).toMatchObject({total:28,from:0,to:0,hasNext:false,hasPrev:true});
  expect([...page1.rows,...page2.rows].every(row=>typeof row.effectiveOn==='string')).toBe(true);
  expect(JSON.parse(JSON.stringify([...page1.rows,...page2.rows]))).toEqual(expectedRows);
 }finally{probe.restore();}
 const statements=probe.queries.filter(row=>row.sql.includes('analytics_changeJobTransactions_page'));
 expect(statements).toHaveLength(3);expect(statements.map(row=>row.rows)).toEqual([25,3,1]);
 expect(probe.state).toEqual({active:0,maxActive:1});
 await expect(changeJobTransactionsPage(ctx,[],{...query,page:{...first,offset:1}})).rejects.toThrow('Invalid analytics page');
});

it('retains exact predecessor multiplicity, corrections, both-side filters and genesis/termination exclusions',async()=>{
 const b=await seedBase(),ctx=adminCtx(b),{ids,people}=await seedRows(b,3),effectiveOn='2021-05-01';
 const [zeroId,successorId]=[randomUUID(),randomUUID()].sort();
 const [target]=await owner.db.insert(position).values({tenantId:b.tenantId,companyId:b.companyId,title:'Fictional changed position'}).returning({id:position.id});
 await owner.db.update(assignment).set({validTo:effectiveOn}).where(eq(assignment.employmentId,ids[0]));
 await owner.db.insert(assignment).values([
  {id:zeroId,tenantId:b.tenantId,employmentId:ids[0],companyId:b.companyId,departmentId:b.deptB,employmentType:'full_time',validFrom:effectiveOn,validTo:effectiveOn},
  {tenantId:b.tenantId,employmentId:ids[0],companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',validFrom:'2018-01-01',validTo:effectiveOn,supersededAt:new Date()},
  {tenantId:b.tenantId,employmentId:ids[0],companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',validFrom:'2017-01-01',validTo:'2018-01-01'},
  {id:successorId,tenantId:b.tenantId,employmentId:ids[0],companyId:b.companyId,departmentId:b.deptB,positionId:target.id,employmentType:'full_time',validFrom:effectiveOn},
 ]);
 await terminateEmployment(ctx,{employmentId:ids[1],terminationDate:effectiveOn,terminationType:'voluntary'});
 const request={from:effectiveOn,to:effectiveOn,page:first};
 const full=await changeJobTransactions(ctx,[],request),actual=await changeJobTransactionsPage(ctx,[],request);
 // [D,D) is empty under the real no-overlap exclusion. It is both a
 // successor and an exact-boundary predecessor, legitimately yielding 2x2.
 expect(actual.rows.slice().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))).toEqual(full.slice().sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));expect(actual.state.total).toBe(4);
 expect(actual.rows.map(row=>row.fromDepartment).sort()).toEqual(['Finance','Finance','Operations','Operations']);
 expect(actual.rows.map(row=>row.toPosition)).toEqual([null,null,'Fictional changed position','Fictional changed position']);
 expect(actual.rows.every(row=>row.name==='Fictional report 00000'&&row.fromPosition===null&&row.effectiveOn===effectiveOn)).toBe(true);
 expect((await changeJobTransactionsPage(ctx,[],{...request,filter:{departmentId:b.deptA}})).state.total).toBe(2);
 expect((await changeJobTransactionsPage(ctx,[],{...request,filter:{departmentId:b.deptB}})).state.total).toBe(4);
 for(const q of ['%', 'Fictional report 0000_', 'example.invalid'])expect((await changeJobTransactionsPage(ctx,[],{...request,filter:{q}})).state.total).toBe(4);
 expect((await changeJobTransactionsPage(ctx,[],{...request,filter:{q:'Definitely absent'}})).rows).toEqual([]);
 expect((await changeJobTransactionsPage(ctx,[],{...request,from:'2021-05-02'})).state.total).toBe(0);
 // Correct the canonical predecessor. Its other, still-canonical matching
 // predecessor remains; neither arbitrary-nearest nor DISTINCT is permitted.
 await owner.db.update(assignment).set({supersededAt:new Date()}).where(sql`${assignment.employmentId}=${ids[0]} and ${assignment.validFrom}='2020-01-01'`);
 const corrected=await changeJobTransactionsPage(ctx,[],request);
 expect(corrected.state.total).toBe(2);expect(corrected.rows.map(row=>row.fromDepartment)).toEqual(['Operations','Operations']);
 expect((await changeJobTransactionsPage(ctx,[],{...request,filter:{departmentId:b.deptA}})).rows).toEqual([]);
 const foreign=await seedBase();expect((await changeJobTransactionsPage(ctx,[foreign.companyId],request)).state.total).toBe(0);
 const foreignEmployee=await hireEmployee(adminCtx(foreign),{person:{fullName:'Fictional foreign change',primaryEmail:'foreign-change@example.invalid'},companyId:foreign.companyId,departmentId:foreign.deptA,employmentType:'full_time',hiredOn:'2020-01-01'});
 await transferEmployee(adminCtx(foreign),{employmentId:foreignEmployee.employmentId,effectiveDate:effectiveOn,departmentId:foreign.deptB});
 expect((await changeJobTransactionsPage(ctx,[],request)).state.total).toBe(2);
 const userId=await createAppUser(b.tenantId,people[2],'employee'),employee:SessionContext={tenantId:b.tenantId,userId,personId:people[2],roles:['employee']};
 expect((await changeJobTransactionsPage(employee,[],request)).rows).toEqual([]);
 await owner.db.delete(roleAssignment).where(eq(roleAssignment.appUserId,b.adminUserId));
 const refused=observeNativeRead();
 try{await expect(changeJobTransactionsPage(ctx,[],request)).rejects.toThrow('calling authority');}finally{refused.restore();}
 expect(refused.queries.some(row=>row.sql.includes('analytics_changeJobTransactions_page'))).toBe(false);
});


it('counts the complete change-job relation beyond All and preserves complete export rows',async()=>{
 const b=await seedBase(),ctx=adminCtx(b),{ids}=await seedRows(b,2052);
 await owner.db.update(assignment).set({validTo:'2021-01-01'}).where(inArray(assignment.employmentId,ids));
 for(let offset=0;offset<ids.length;offset+=500)await owner.db.insert(assignment).values(ids.slice(offset,offset+500).map(employmentId=>({tenantId:b.tenantId,employmentId,companyId:b.companyId,departmentId:b.deptB,employmentType:'full_time'as const,validFrom:'2021-01-01'})));
 const request={from:'2021-01-01',to:'2021-01-01'};
 const all=await changeJobTransactionsPage(ctx,[],{...request,page:parsePageQuery({size:'all'})});
 expect(all.rows).toHaveLength(2000);expect(all.state).toMatchObject({total:2052,truncated:true,from:1,to:2000});
 const last=await changeJobTransactionsPage(ctx,[],{...request,page:parsePageQuery({page:'82'})});
 expect(last.rows.map(row=>row.name)).toEqual(['Fictional report 02050','Fictional report 02051']);expect(last.state.total).toBe(2052);
 const full=await changeJobTransactions(ctx,[],request);expect(full).toHaveLength(2052);expect(all.rows).toEqual(full.slice(0,2000));
},120000);

type CarryBoundaryStage='abort'|'seed-start'|'seed-return'|'seed-batch-return'|'pair-start'|'pair-return'|'ordered-start'|'ordered-return'|'phase-start'|'rename-reset'|'rename-return'|'active-batch-return'|'unicode-late-return'|'page-start'|'fetch-return'|'oracle-complete'|'phase-complete'|'drain-start'|'drain-complete'|'final';
type CarryBoundaryEvent={stage:CarryBoundaryStage;epochMs:number;elapsedMs:number;phase:number;page:number;rows?:number;nativeMs?:number;assertionMs?:number;returned?:boolean};
type CarryBoundaryIdentity={pid:number;started:string;database:string;login:string;role:string;isolation:string;readOnly:boolean};
type CarryBoundarySlot={epoch:number;armed:boolean;closing:boolean;active:number;pending:Set<Promise<unknown>>;identity?:CarryBoundaryIdentity;cancel?:Promise<void>;tag:string};
/** B1-only lifetime owner. Private native identities never enter the bounded receipt. */
class CarryBoundaryScope{
 readonly events:CarryBoundaryEvent[]=[];phase=-1;page=-1;stopped=false;settled=false;poisoned=false;
 private readonly started=performance.now();private nextEpoch=0;private readonly slots=new Set<CarryBoundarySlot>();
 private pending?:Promise<void>;private finishing?:Promise<void>;private restore?:()=>void;private bodyFailed=false;
 private control?:Awaited<ReturnType<typeof owner.client.reserve>>;private readonly identities:CarryBoundaryIdentity[]=[];private idleVerified=false;private controlUncertain=false;private controlIdentity?:CarryBoundaryIdentity;private visibleTargets=0;
 nativeOperations=0;nativeAwaitMs=0;
 private evidenceFailed=false;private ownerDatabase='';private ownerLogin='';private cancellationIssued=false;private cancellationSettled=true;private cancellationResult:'not-issued'|'pending'|'no-match'|'accepted'|'refused'|'unavailable'='not-issued';
 private observerInstalled=false;private observerRestored=false;private resolverInstalled=false;private resolverRestored=false;
 private readonly abort=()=>{this.stopped=true;this.event('abort');for(const slot of this.slots)this.cancel(slot);};
 constructor(private readonly signal:AbortSignal){signal.addEventListener('abort',this.abort,{once:true});if(signal.aborted)this.abort();}
 check(){if(this.stopped||this.signal.aborted)throw this.signal.reason??new Error('Carry boundary aborted');}
 event(stage:CarryBoundaryStage,extra:Partial<Pick<CarryBoundaryEvent,'rows'|'nativeMs'|'assertionMs'|'returned'>>={}){
  if(this.events.length>=128){this.evidenceFailed=true;return undefined;}
  const event={stage,epochMs:Date.now(),elapsedMs:performance.now()-this.started,phase:this.phase,page:this.page,...extra};this.events.push(event);this.save();return event;
 }
 save(){
  const directory=process.env.AIHR_FOCUSED_EVIDENCE_DIR;if(!directory)return;
  const report={kind:'NATIVE_CARRY_BOUNDARY_PHASES_COMPONENT_ONLY',releaseEligible:false,source:process.env.AIHR_CI_HEAD,controller:process.env.AIHR_CI_CONTROL_HEAD,
   runId:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,complete:this.settled&&!this.bodyFailed&&!this.poisoned&&!this.evidenceFailed,
   stopped:this.stopped,settled:this.settled,poisoned:this.poisoned,cancellationIssued:this.cancellationIssued,cancellationSettled:this.cancellationSettled,cancellationResult:this.cancellationResult,observerInstalled:this.observerInstalled,observerRestored:this.observerRestored,resolverInstalled:this.resolverInstalled,resolverRestored:this.resolverRestored,idleVerified:this.idleVerified,controlUncertain:this.controlUncertain,nativeIdentities:this.identities.length,nativeOperations:this.nativeOperations,nativeAwaitMs:this.nativeAwaitMs,rowTypeChecks:this.events.filter(event=>event.stage==='fetch-return').reduce((n,event)=>n+2*(event.rows??0),0),distinctControlVerified:this.controlIdentity!==undefined&&this.visibleTargets===this.identities.length,active:[...this.slots].reduce((n,s)=>n+s.active,0),held:this.slots.size,events:this.events};
  try{const bytes=JSON.stringify(report);if(Buffer.byteLength(bytes)>65536){this.evidenceFailed=true;return;}writeFileSync(join(directory,'analytics-carry-boundaries.json'),bytes);}catch{this.evidenceFailed=true;}
 }
 async prepare(){
  try{this.check();if(owner.client.options.max<2)throw new Error('Carry boundary owner control capacity unavailable');
  this.control=await owner.client.reserve();
  const facts=await this.controlTransaction(async connection=>{
   const [facts]=await connection<CarryBoundaryIdentity[]>`select pg_backend_pid() as pid,a.backend_start::text as started,current_database() as database,session_user as login,current_user as role,current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only')='on' as "readOnly" from pg_stat_activity a where a.pid=pg_backend_pid()`;
   return facts;
  });
  this.check();if(!facts?.database||facts.login!=='postgres'||facts.role!=='postgres'||facts.isolation!=='read committed'||facts.readOnly||!Number.isSafeInteger(facts.pid)||facts.pid<=0||!facts.started)throw new Error('Carry boundary owner context unavailable');
  this.controlIdentity=facts;this.ownerDatabase=facts.database;this.ownerLogin=facts.login;
  }catch(error){this.poisoned=true;throw error;}
 }
 /** ReservedSql's pinned runtime exposes tagged SQL/release, not its declared .begin. */
 private async controlTransaction<T>(work:(connection:Awaited<ReturnType<typeof owner.client.reserve>>)=>Promise<T>):Promise<T>{
  const control=this.control;if(!control){this.controlUncertain=true;this.poisoned=true;throw new Error('Carry boundary reserved control unavailable');}
  try{
   await control`begin`;await control`set local statement_timeout='1s'`;await control`set local lock_timeout='300ms'`;
   if(this.controlIdentity){
    const [current]=await control<Pick<CarryBoundaryIdentity,'pid'|'started'|'database'|'login'|'role'>[]>`select pg_backend_pid() as pid,a.backend_start::text as started,current_database() as database,session_user as login,current_user as role from pg_stat_activity a where a.pid=pg_backend_pid()`;
    const original=this.controlIdentity;
    if(!current||current.pid!==original.pid||current.started!==original.started||current.database!==original.database||current.login!==original.login||current.role!==original.role)throw new Error('Carry boundary reserved physical identity changed');
   }
   const result=await work(control);await control`commit`;return result;
  }catch(error){
   this.controlUncertain=true;this.poisoned=true;
   try{await control`rollback`;}catch{this.controlUncertain=true;this.poisoned=true;}
   throw error;
  }
 }
 private cancel(slot:CarryBoundarySlot){
  if(this.cancellationIssued||!this.slots.has(slot)||!slot.armed||slot.closing||slot.active!==1||!slot.identity)return;
  this.cancellationIssued=true;this.cancellationSettled=false;this.cancellationResult='pending';const identity=slot.identity,tag=slot.tag;
  // Publish before native work. This promise must never await the target callback/body.
  const control=this.control;if(!control){this.controlUncertain=true;this.poisoned=true;return;}
  slot.cancel=Promise.resolve().then(()=>this.controlTransaction(async connection=>{
   const result=await connection<{cancelled:boolean}[]>`select pg_cancel_backend(a.pid) as cancelled from pg_stat_activity a
    where a.pid=${identity.pid} and a.backend_start::text=${identity.started} and a.datname=${identity.database}
     and a.usename=${identity.login} and a.application_name=${tag} and a.state='active' and a.backend_type='client backend'`;
   if(result.length>1||result.some(row=>typeof row.cancelled!=='boolean'))throw new Error('Carry boundary cancellation reply refused');
   this.cancellationResult=result.length===0?'no-match':result[0].cancelled?'accepted':'refused';
  })).catch(()=>{this.cancellationResult='unavailable';this.poisoned=true;}).finally(()=>{this.cancellationSettled=true;});
 }
 private async native<T>(slot:CarryBoundarySlot,work:()=>Promise<T>):Promise<T>{
  this.check();if(slot.closing||!slot.armed)throw new Error('Carry boundary transaction is closing');
  if(slot.active!==0){this.poisoned=true;throw new Error('Concurrent carry boundary native work');}
  const started=performance.now();slot.active++;const pending=Promise.resolve().then(()=>{this.check();return work();});slot.pending.add(pending);
  try{const result=await pending;this.check();return result;}finally{this.nativeOperations++;this.nativeAwaitMs+=performance.now()-started;slot.active--;slot.pending.delete(pending);}
 }
 private guard<T extends object>(value:T,slot:CarryBoundarySlot):T{
  return new Proxy(value,{get:(target,key)=>{
   const member=Reflect.get(target,key,target);
   if(key==='then'&&typeof member==='function')return(onFulfilled:unknown,onRejected:unknown)=>
    Reflect.apply(Promise.prototype.then,this.native(slot,()=>Promise.resolve(target)),[onFulfilled,onRejected]);
   if(typeof member!=='function')return member;
   return(...args:unknown[])=>{this.check();const next=Reflect.apply(member,target,args);return next!==null&&typeof next==='object'?this.guard(next,slot):next;};
  }});
 }
 async held<T>(tx:Tx,kind:'fixture'|'command'|'read',body:(guarded:Tx)=>Promise<T>):Promise<T>{
  this.check();const slot:CarryBoundarySlot={epoch:++this.nextEpoch,armed:false,closing:false,active:0,pending:new Set(),tag:'carry-boundary-'+randomUUID()};this.slots.add(slot);
  let outcome:{ok:true;value:T}|{ok:false;error:unknown};
  try{
   await tx.execute(sql`set local statement_timeout='20s'`);await tx.execute(sql`set local lock_timeout='300ms'`);
   await tx.execute(sql`select set_config('application_name',${slot.tag},true)`);
   const [identity]=await tx.execute<CarryBoundaryIdentity>(sql`select pg_backend_pid() as pid,a.backend_start::text as started,current_database() as database,
    session_user as login,current_user as role,current_setting('transaction_isolation') as isolation,current_setting('transaction_read_only')='on' as "readOnly"
    from pg_stat_activity a where a.pid=pg_backend_pid()`);
   if(!identity||!Number.isSafeInteger(identity.pid)||identity.pid<=0||!identity.started||identity.database!==this.ownerDatabase
    ||identity.login!==(kind==='fixture'?this.ownerLogin:'ai_hr_app')||identity.role!==(kind==='fixture'?this.ownerLogin:'ai_hr_app')
    ||(kind==='read'&&(identity.isolation!=='repeatable read'||!identity.readOnly))
    ||(kind!=='read'&&(identity.isolation!=='read committed'||identity.readOnly)))throw new Error('Carry boundary native identity refused');
   const control=this.control;if(!control||identity.pid===this.controlIdentity?.pid)throw new Error('Carry boundary distinct control unavailable');
   await this.controlTransaction(async connection=>{
     const [visible]=await connection<{matches:number}[]>`select count(*)::int as matches from pg_stat_activity
     where pid=${identity.pid} and backend_start::text=${identity.started} and datname=${identity.database} and usename=${identity.login} and application_name=${slot.tag}`;
    if(visible?.matches!==1)throw new Error('Carry boundary native control target unavailable');
   });this.visibleTargets++;
   slot.identity=identity;this.identities.push(identity);slot.armed=true;this.check();outcome={ok:true,value:await body(this.guard(tx,slot))};
  }catch(error){if(!slot.identity)this.poisoned=true;outcome={ok:false,error};}
  // Synchronous admission frontier: no later abort may enqueue against this epoch.
  slot.closing=true;slot.armed=false;
  if(slot.pending.size)await Promise.allSettled([...slot.pending]);
  if(slot.cancel)await slot.cancel;
  if(slot.active!==0||this.controlUncertain){this.poisoned=true;this.save();await new Promise<never>(()=>{});}
  this.slots.delete(slot);
  if(!outcome.ok)throw outcome.error;this.check();return outcome.value;
 }
 fixture<T>(body:(tx:Tx)=>Promise<T>){return owner.db.transaction(tx=>this.held(tx,'fixture',body));}
 setRestore(restore:()=>void){this.observerInstalled=true;this.restore=restore;}
 markResolverInstalled(){this.resolverInstalled=true;}
 markResolverRestored(){this.resolverRestored=true;}
 run(body:()=>Promise<void>){
  if(this.pending)throw new Error('Carry boundary body already owned');
  this.pending=Promise.resolve().then(body).catch(error=>{this.bodyFailed=true;throw error;});
  void this.pending.catch(()=>{});return this.pending;
 }
 finish(){
  if(this.finishing)return this.finishing;
  this.finishing=(async()=>{
   this.event('drain-start');if(this.pending)try{await this.pending;}catch{/* Original body/timeout remains the test failure. */}
   if(this.slots.size){this.poisoned=true;throw new Error('Carry boundary held callbacks remain');}
   if(this.poisoned){this.save();throw new Error('Carry boundary ownership poisoned; reserved holder retained');}
   const control=this.control;
   if(control){
    await this.controlTransaction(async connection=>{
       for(const identity of this.identities){
      const activity=await connection<{state:string;xactStart:string|null}[]>`select state,xact_start::text as "xactStart" from pg_stat_activity
       where pid=${identity.pid} and backend_start::text=${identity.started} and datname=${identity.database} and usename=${identity.login}`;
      if(activity.length>1||activity.some(row=>row.state!=='idle'||row.xactStart!==null)){this.poisoned=true;throw new Error('Carry boundary original backend not idle');}
     }
    });this.idleVerified=true;control.release();this.control=undefined;
   }else if(this.identities.length){this.poisoned=true;throw new Error('Carry boundary idle observer unavailable');}
   this.signal.removeEventListener('abort',this.abort);this.restore?.();this.observerRestored=this.observerInstalled;this.restore=undefined;
   this.event('drain-complete');this.event('final');
   if(!this.bodyFailed){
    const count=(stage:CarryBoundaryStage)=>this.events.filter(event=>event.stage===stage).length;
    const rows=(stage:CarryBoundaryStage)=>this.events.filter(event=>event.stage===stage).reduce((n,event)=>n+(event.rows??0),0);
    if(this.stopped||!this.observerRestored||!this.resolverRestored||!this.cancellationSettled||this.events.length!==125||count('phase-complete')!==7||count('page-start')!==11||count('fetch-return')!==17||count('oracle-complete')!==11
     ||count('active-batch-return')!==33||count('seed-batch-return')!==9||rows('fetch-return')!==30212||rows('oracle-complete')!==30212
     ||this.events.some(event=>event.stage==='page-start'&&!event.returned))this.evidenceFailed=true;
   }
   this.settled=true;this.save();
   if(this.poisoned||this.evidenceFailed)throw new Error('Carry boundary settlement or evidence unavailable');
  })();return this.finishing;
 }
 refuseUnsettled(){if(!this.settled||this.poisoned)throw new Error('Carry boundary must settle before reset or close');}
}
let carryBoundaryScope:CarryBoundaryScope|undefined;

type ObservedCarryIdentity={employmentId:string;name:string};
type ObservedCarryProperties={role:string;isolation:string;readOnly:boolean;pid:number};
/** Case-private observation of the actual app cursor; rows never leave test memory.
 * The original RowList is returned unchanged, and the oracle below sorts this SAME stream. */
function observeCarryCursor(failAfterFirstFetch=false,scope?:CarryBoundaryScope){
 const actual=database.withTenant,dialect=new PgDialect(),rows:ObservedCarryIdentity[]=[],batches:number[]=[],queries:string[]=[],properties:ObservedCarryProperties[]=[];
 const state={active:0,maxActive:0};let originalFetchFailure:unknown,controlClosed=false;
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(context:SessionContext,read:(tx:Tx)=>Promise<T>,options?:Parameters<typeof database.withTenant>[2])=>actual(context,async tx=>{
  scope?.check();
  const [facts]=await tx.execute<ObservedCarryProperties>(sql`select current_user as role,current_setting('transaction_isolation')as isolation,
   current_setting('transaction_read_only')='on'as "readOnly",pg_backend_pid()as pid`);
  scope?.check();properties.push(facts);
  const invoke=(native:Tx)=>read(new Proxy(native,{get(target,key,receiver){
   if(key==='execute')return async(statement:SQL)=>{
    const compiled=dialect.sqlToQuery(statement),text=compiled.sql.trim().toLowerCase().replace(/\s+/g,' ');
    queries.push(text);state.active++;state.maxActive=Math.max(state.maxActive,state.active);
    try{
     let result:Awaited<ReturnType<Tx['execute']>>;const nativeStarted=performance.now();
     try{result=await target.execute(statement);}catch(error){
      if(text==='fetch forward 4096 from analytics_carry_identities')originalFetchFailure=error;
      throw error;
     }
     const nativeMs=performance.now()-nativeStarted,assertionStarted=performance.now();
     if(text==='fetch forward 4096 from analytics_carry_identities'){
      expect(compiled.params).toEqual([]);expect(Array.isArray(result)).toBe(true);expect(result.length).toBeLessThanOrEqual(4096);
      batches.push(result.length);
      for(const row of result){
       expect(typeof row.employmentId).toBe('string');expect(typeof row.name).toBe('string');
       rows.push({employmentId:row.employmentId as string,name:row.name as string});
      }
      scope?.event('fetch-return',{rows:result.length,nativeMs,assertionMs:performance.now()-assertionStarted});
      if(failAfterFirstFetch&&!controlClosed){
       // A real same-session CLOSE makes the NEXT unmodified product FETCH fail natively.
       await target.execute(sql`close analytics_carry_identities`);controlClosed=true;
      }
     }
     return result;
    }finally{state.active--;}
   };
   const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
  }}));
  return scope?scope.held(tx,options?.readOnlySnapshot?'read':'command',invoke):invoke(tx);
 },options));
 return {rows,batches,queries,properties,state,resetPage(){if(state.active!==0)throw new Error('Carry boundary observer still active');rows.length=0;batches.length=0;queries.length=0;properties.length=0;state.active=0;state.maxActive=0;},get originalFetchFailure(){return originalFetchFailure;},
  get controlClosed(){return controlClosed;},restore:()=>spy.mockRestore()};
}
function expectCarryCursorPage(probe:ReturnType<typeof observeCarryCursor>,page:ReturnType<typeof parsePageQuery>,result:Awaited<ReturnType<typeof carryForwardReportPage>>,total:number){
 const expected=probe.rows.slice().sort((a,b)=>a.name.localeCompare(b.name)).slice(page.offset,page.offset+page.limit);
 expect(result.rows.map(row=>row.employmentId)).toEqual(expected.map(row=>row.employmentId));
 expect(result.state.total).toBe(total);expect(probe.rows).toHaveLength(total);
 expect(probe.properties).toHaveLength(1);expect(probe.properties[0]).toMatchObject({role:'ai_hr_app',isolation:'repeatable read',readOnly:true});
 expect(probe.state).toEqual({active:0,maxActive:1});
 const lastFetch=probe.queries.lastIndexOf('fetch forward 4096 from analytics_carry_identities'),closed=probe.queries.indexOf('close analytics_carry_identities');
 expect(lastFetch).toBeGreaterThan(-1);expect(closed).toBeGreaterThan(lastFetch);
 expect(probe.queries.filter(query=>query==='close analytics_carry_identities')).toHaveLength(1);
}
async function expectCarryPidSettled(pid:number){
 const activity=await owner.client<{state:string;xactStart:string|null}[]>`select state,xact_start as "xactStart" from pg_stat_activity where pid=${pid}`;
 expect(activity.length).toBeLessThanOrEqual(1);
 if(activity.length)expect(activity[0]).toMatchObject({state:'idle',xactStart:null});
}

it('preserves stable same-native-stream carry pages across fixed4096 fetch boundaries',async(context)=>{
 const scope=new CarryBoundaryScope(context.signal);carryBoundaryScope=scope;
 context.onTestFinished(()=>scope.finish());
 await scope.run(async()=>{
 scope.event('seed-start');await scope.prepare();
 const b=await seedBase(),ctx=adminCtx(b),probe=observeCarryCursor(false,scope);scope.setRestore(probe.restore);
 const seeded=await scope.fixture(tx=>seedRows(b,4095,{}, {tx,scope}));scope.event('seed-return');scope.event('pair-start');
 const paired=await hireEmployee(ctx,{companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time',hiredOn:'2020-01-01',
  person:{fullName:'Excluded carry paired',primaryEmail:randomUUID()+'@example.invalid'}});
 const concurrent=await hireEmployee(ctx,{companyId:b.companyId,departmentId:b.deptB,employmentType:'part_time',hiredOn:'2020-01-01',person:{id:paired.personId}});
 scope.event('pair-return');scope.event('ordered-start');
 const ordered=await scope.fixture(async tx=>tx.select({employmentId:employment.id,personId:employment.personId}).from(employment).where(eq(employment.companyId,b.companyId)).orderBy(employment.id));scope.event('ordered-return');
 expect(ordered).toHaveLength(4097);
 const latePerson=ordered.at(-1)!.personId,lateEmployment=ordered.at(-1)!.employmentId;
 const unicode=['éclair','Eclair','e\u0301clair','Ångström','Zulu','同名','😀','éclair'];
 const actualResolver=templates.buildTemplateEntitlementResolver,selectedBatches:string[][]=[];
 const resolver=vi.spyOn(templates,'buildTemplateEntitlementResolver').mockImplementation((tx,p)=>{selectedBatches.push(p.employmentIds.slice());return actualResolver(tx,p);});
 scope.markResolverInstalled();
 try{
  for(const [phase,n] of [0,511,512,513,4095,4096,4097].entries()){
   scope.check();scope.phase=phase;scope.page=-1;scope.event('phase-start');
   // One Person may own two legal distinct Employments. Select counts through
   // real Person names without trying to hide only one of that Person's rows.
   const activePeople=n<=4095?seeded.people.slice(0,n):[...seeded.people.slice(0,n===4096?4094:4095),paired.personId];
   scope.event('rename-reset');
   await scope.fixture(async tx=>{
   await tx.update(person).set({fullName:sql`'Excluded carry ' || ${person.id}::text`}).where(eq(person.tenantId,b.tenantId));
   scope.event('rename-return');
   for(let start=0;start<activePeople.length;start+=500){await tx.update(person).set({fullName:sql`'Carry boundary z ' || ${person.id}::text`}).where(inArray(person.id,activePeople.slice(start,start+500)));scope.event('active-batch-return',{rows:Math.min(500,activePeople.length-start)});}
   const unicodePeople=activePeople.filter(id=>id!==latePerson).slice(0,unicode.length);
   for(const [index,name]of unicode.entries())if(unicodePeople[index])await tx.update(person).set({fullName:'Carry boundary '+name}).where(eq(person.id,unicodePeople[index]));
   if(activePeople.includes(latePerson))await tx.update(person).set({fullName:'Carry boundary 000 late winner'}).where(eq(person.id,latePerson));
   });scope.event('unicode-late-return');
   const pages=[first];
   if(n===4097)for(const size of [25,50,100,200])pages.push(parsePageQuery({size:String(size),page:String(Math.floor((n-1)/size))}));
   for(const page of pages){
    scope.check();scope.page++;selectedBatches.length=0;probe.resetPage();const pageEvent=scope.event('page-start'),nativeStarted=scope.nativeAwaitMs;
    let result:Awaited<ReturnType<typeof carryForwardReportPage>>;
    result=await carryForwardReportPage(ctx,[b.companyId],{year:2026,filter:{q:'Carry boundary %'},page});if(pageEvent){pageEvent.returned=true;pageEvent.nativeMs=scope.nativeAwaitMs-nativeStarted;scope.save();}
    scope.check();const oracleStarted=performance.now();
    expectCarryCursorPage(probe,page,result!,n);
    expect(probe.batches).toEqual(n<4096?[n]:n===4096?[4096,0]:[4096,1]);
    expect(new Set(probe.rows.map(row=>row.employmentId)).size).toBe(n);
    if(n){
     for(const name of unicode)expect(probe.rows.some(row=>row.name==='Carry boundary '+name)).toBe(true);
     expect(probe.rows.filter(row=>row.name==='Carry boundary éclair')).toHaveLength(2);
    }
    if(result!.rows.length){
     expect(selectedBatches).toHaveLength(1);expect(selectedBatches[0].slice().sort()).toEqual(result!.rows.map(row=>row.employmentId).sort());
    }else expect(selectedBatches).toEqual([]);
    if(n>=4096)expect(probe.rows.filter(row=>row.employmentId===paired.employmentId||row.employmentId===concurrent.employmentId)).toHaveLength(2);
    if(n===4097&&page.page===0){
     expect(probe.rows.at(-1)?.employmentId).toBe(lateEmployment);
     expect(result!.rows.map(row=>row.employmentId)).toContain(lateEmployment);
    }
    scope.event('oracle-complete',{rows:n,assertionMs:performance.now()-oracleStarted});
   }
   scope.event('phase-complete');
  }
 }finally{resolver.mockRestore();scope.markResolverRestored();}
 });
},120000);

it('retains full carry population and exports for All and safe very-deep page arithmetic',async()=>{
 const b=await seedBase(),ctx=adminCtx(b);await seedRows(b,4097);
 const full=await carryForwardReport(ctx,[b.companyId],{year:2026});
 expect(full).toHaveLength(4097);
 const pages=[parsePageQuery({size:'all'}),...([25,50,100,200]as const).map(size=>parsePageQuery({size:String(size),page:'1'}))];
 const veryDeep=parsePageQuery({size:'25',page:String(Math.floor(Number.MAX_SAFE_INTEGER/25))});
 expect(Number.isSafeInteger(veryDeep.offset)).toBe(true);expect(Number.isSafeInteger(veryDeep.offset+veryDeep.limit)).toBe(false);
 pages.push(veryDeep);
 for(const page of pages){
  const probe=observeCarryCursor();let result:Awaited<ReturnType<typeof carryForwardReportPage>>;
  try{result=await carryForwardReportPage(ctx,[b.companyId],{year:2026,page});}finally{probe.restore();}
  expectCarryCursorPage(probe,page,result!,4097);expect(probe.batches).toEqual([4096,1]);
  expect(result!.rows).toEqual(full.slice(page.offset,page.offset+page.limit));
  if(page.size==='all')expect(result!.state).toMatchObject({total:4097,from:1,to:2000,truncated:true});
  if(page===veryDeep)expect(result!).toMatchObject({rows:[],state:{total:4097,from:0,to:0,hasPrev:true}});
 }
},120000);

it('propagates an actual native carry FETCH failure and settles its borrowed transaction',async()=>{
 const b=await seedBase(),ctx=adminCtx(b);await seedRows(b,4096);
 const probe=observeCarryCursor(true);let caught:unknown;
 try{await carryForwardReportPage(ctx,[b.companyId],{year:2026,page:first});}catch(error){caught=error;}finally{probe.restore();}
 expect(probe.controlClosed).toBe(true);expect(probe.batches).toEqual([4096]);
 expect(probe.originalFetchFailure).toBeDefined();expect(caught).toBe(probe.originalFetchFailure);expect(pgSqlState(caught)).toBe('34000');
 expect(probe.queries.filter(query=>query==='fetch forward 4096 from analytics_carry_identities')).toHaveLength(2);
 expect(probe.queries).not.toContain('close analytics_carry_identities');expect(probe.state).toEqual({active:0,maxActive:1});
 expect(probe.properties).toHaveLength(1);expect(probe.properties[0]).toMatchObject({role:'ai_hr_app',isolation:'repeatable read',readOnly:true});
 await expectCarryPidSettled(probe.properties[0].pid);
 const full=await carryForwardReport(ctx,[b.companyId],{year:2026}),fresh=await carryForwardReportPage(ctx,[b.companyId],{year:2026,page:first});
 expect(fresh.state.total).toBe(4096);expect(fresh.rows).toEqual(full.slice(0,25));
},120000);
