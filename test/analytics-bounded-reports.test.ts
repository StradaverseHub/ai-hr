import {randomUUID} from 'node:crypto';
import {eq,inArray,sql} from 'drizzle-orm';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import {assignment,company,department,employment,leaveLedger,leaveType,person,roleAssignment} from '../db/schema';
import {hireEmployee,terminateEmployment,transferEmployee} from '../core/org';
import {
 analyticsManagerSelection,carryForwardReport,carryForwardReportPage,changeJobTransactions,changeJobTransactionsPage,
 headcountSummary,masterDataCount,masterDataExport,newHires,newHiresPage,terminations,terminationsPage,
} from '../core/analytics';
import * as templates from '../core/entitlement-template';
import {parsePageQuery} from '../lib/pagination';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

beforeAll(migrateTestDb);beforeEach(resetDb);afterAll(closeAll);
const period={from:'2020-01-01',to:'2026-12-31'};
const first=parsePageQuery();
async function seedRows(b:Base,n:number,p:{terminatedOn?:string;name?:(i:number)=>string;hiredOn?:string}={}){
 const ids:string[]=[],people:string[]=[];
 for(let offset=0;offset<n;offset+=500){
  const indices=Array.from({length:Math.min(500,n-offset)},(_,i)=>offset+i);
  const personRows=indices.map(i=>({id:randomUUID(),tenantId:b.tenantId,fullName:p.name?.(i)??`Fictional report ${String(i).padStart(5,'0')}`,primaryEmail:randomUUID()+'@example.invalid'}));
  const employmentRows=personRows.map(row=>({id:randomUUID(),tenantId:b.tenantId,personId:row.id,companyId:b.companyId,hiredOn:p.hiredOn??'2020-01-01',terminatedOn:p.terminatedOn??null}));
  await owner.db.insert(person).values(personRows);
  await owner.db.insert(employment).values(employmentRows);
  await owner.db.insert(assignment).values(employmentRows.map(row=>({tenantId:b.tenantId,employmentId:row.id,companyId:b.companyId,departmentId:b.deptA,employmentType:'full_time' as const,validFrom:row.hiredOn})));
  ids.push(...employmentRows.map(row=>row.id));people.push(...personRows.map(row=>row.id));
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
