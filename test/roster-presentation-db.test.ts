import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {eq,sql,type SQL} from 'drizzle-orm';
import {PgDialect} from 'drizzle-orm/pg-core';
import {afterAll,beforeAll,beforeEach,expect,it,vi} from 'vitest';
import * as database from '../db/client';
import type {SessionContext,Tx} from '../db/client';
import * as schema from '../db/schema';
import {adminCtx,closeAll,createAppUser,migrateTestDb,owner,resetDb,seedBase} from './harness';
import {hireEmployee} from '../core/org';
import {assignDefaultShift,assignShift,createShift,rosterWindowView,setRestDay} from '../core/roster';
import {rosterWindowPage,rosterPopulationIds} from '../core/roster-presentation';
import {cellKey,resolveRosterCell} from '../lib/roster-month';
import {todayInKualaLumpur} from '../lib/hr-date';
import {seedPersonnelNativeFixture} from './performance/personnel-native-fixture';

beforeAll(migrateTestDb);afterAll(closeAll);beforeEach(resetDb);
const window={from:'2027-01-04',to:'2027-01-10'};
async function fixture(){
 const b=await seedBase(),ctx=adminCtx(b),ids:string[]=[];
 for(let i=0;i<32;i++)ids.push((await hireEmployee(ctx,{person:{fullName:'Roster '+String(i).padStart(3,'0'),primaryEmail:`roster${i}@example.invalid`},companyId:b.companyId,departmentId:i<26?b.deptA:b.deptB,positionId:b.positionId,employmentType:'full_time',hiredOn:'2020-01-01',employeeCode:'R'+i})).employmentId);
 const shift=(await createShift(ctx,{name:'Roster page morning',code:'PG',startTime:'09:00',endTime:'18:00',weeklyPattern:[1,2,3,4,5]})).id;
 await assignDefaultShift(ctx,{employmentId:ids[25],shiftId:shift});
 await assignShift(ctx,{employmentId:ids[25],shiftDate:window.from,shiftId:shift});
 await setRestDay(ctx,{employmentId:ids[25],shiftDate:'2027-01-05'});
 await owner.db.update(schema.employment).set({terminatedOn:todayInKualaLumpur()}).where(eq(schema.employment.id,ids[0]));
 await owner.db.update(schema.employment).set({terminatedOn:'2099-01-01'}).where(eq(schema.employment.id,ids[31]));
 return {b,ctx,ids,shift};
}

it('matches canonical known cells, dated population, independent facets, exact count and past-end pages',async()=>{
 const {b,ctx,ids,shift}=await fixture(),p={companyIds:[b.companyId],...window};
 const complete=await rosterWindowView(ctx,p),page=await rosterWindowPage(ctx,{...p,offset:24,limit:2});
 expect(complete.employees).toHaveLength(31);expect(page.total).toBe(31);expect(page.employees.map(e=>e.employmentId)).toEqual([ids[25],ids[26]]);
 expect(page.employees).toEqual(complete.employees.slice(24,26));
 expect(page.cells[cellKey(ids[25],window.from)]).toEqual({kind:'shift',shiftId:shift});
 expect(page.cells[cellKey(ids[25],'2027-01-05')]).toEqual({kind:'rest'});
 expect(resolveRosterCell('2027-01-06',page.cells[cellKey(ids[25],'2027-01-06')]??null,page.usual[ids[25]])).toMatchObject({kind:'usual',shiftId:shift});
 for(const employee of page.employees)for(const date of page.dates){const key=cellKey(employee.employmentId,date);expect(page.cells[key]).toEqual(complete.cells[key]);expect(page.dayContext[key]).toEqual(complete.dayContext[key]);}
 expect(Object.keys(page.usual)).toEqual([ids[25]]);expect(page.allEmployees).toEqual([]);
 const filtered=await rosterWindowPage(ctx,{...p,departmentId:b.deptB,offset:0,limit:25});
 expect(filtered.total).toBe(6);expect(filtered.departmentOptions.map(o=>o.id).sort()).toEqual([b.deptA,b.deptB].sort());
 const past=await rosterWindowPage(ctx,{...p,offset:1000,limit:25});expect(past.total).toBe(31);expect(past.employees).toEqual([]);expect(past.cells).toEqual({});
 const one=await rosterWindowPage(ctx,{...p,employmentIds:[ids[31]],offset:0,limit:1});expect(one.employees.map(e=>e.employmentId)).toEqual([ids[31]]);
 expect((await rosterWindowPage(ctx,{...p,employmentIds:['bad-id'],offset:0,limit:1})).employees).toEqual([]);
 const idsOnly=await rosterPopulationIds(ctx,p);expect(idsOnly).toEqual(complete.employees.map(row=>row.employmentId));
});

it('keeps native company, foreign, manager and forged calling authority fenced',async()=>{
 const {b,ctx,ids}=await fixture(),foreign=await seedBase();
 const p={companyIds:[b.companyId],...window,offset:0,limit:25};
 expect((await rosterWindowPage(ctx,{...p,companyIds:[foreign.companyId]})).employees).toEqual([]);
 await expect(rosterWindowPage({...ctx,personId:randomUUID()},p)).rejects.toThrow('calling authority');
 const employee=(await owner.db.select().from(schema.employment).where(eq(schema.employment.id,ids[2])))[0];
 const user=await createAppUser(b.tenantId,employee.personId,'manager');
 await owner.db.insert(schema.reportingLine).values({tenantId:b.tenantId,managerEmploymentId:employee.id,subordinateEmploymentId:ids[3],lineType:'administrative',validFrom:'2020-01-01'});
 const manager:SessionContext={tenantId:b.tenantId,userId:user,personId:employee.personId,roles:['manager']};
 const canonical=await rosterWindowView(manager,{companyIds:[b.companyId],...window}),actual=await rosterWindowPage(manager,p);
 expect(actual.employees).toEqual(canonical.employees);expect(actual.employees.map(e=>e.employmentId)).toContain(ids[3]);expect(actual.employees.map(e=>e.employmentId)).not.toContain(ids[4]);
 await expect(rosterWindowPage({...ctx,userId:randomUUID()},p)).rejects.toThrow('calling authority');
});

it('uses one enforced snapshot and page-only canonical query inputs while an Access writer is open',async()=>{
 const {b,ctx,ids}=await fixture(),actual=database.withTenant,dialect=new PgDialect(),queries:{sql:string;params:unknown[]}[]=[],options:unknown[]=[];
 let changed=false;
 const wrap=(query:object):object=>new Proxy(query,{get(target,key,receiver){
  const value=Reflect.get(target,key,receiver);
  if(key==='then'){
   const prepared=(target as {toSQL?:()=>{sql:string;params:unknown[]}}).toSQL?.();if(prepared)queries.push(prepared);
   return typeof value==='function'?value.bind(target):value;
  }
  return typeof value==='function'?(...args:unknown[])=>{const result=Reflect.apply(value,target,args);return result&&typeof result==='object'&&'then' in result?wrap(result):result;}:value;
 }});
 const spy=vi.spyOn(database,'withTenant').mockImplementation(<T>(session:SessionContext,read:(tx:Tx)=>Promise<T>,opts?:Parameters<typeof database.withTenant>[2])=>{
  options.push(opts);return actual(session,tx=>read(new Proxy(tx,{get(target,key,receiver){
   if(key==='select')return (...args:unknown[])=>wrap(Reflect.apply(target.select,target,args));
   if(key==='execute')return async(query:SQL)=>{const prepared=dialect.sqlToQuery(query);queries.push(prepared);const result=await target.execute(query);
    if(!changed&&prepared.sql.includes('employee_choice_page')){changed=true;await owner.db.update(schema.employment).set({terminatedOn:'2000-01-01'}).where(eq(schema.employment.id,ids[25]));}
    return result;};
   const value=Reflect.get(target,key,receiver);return typeof value==='function'?value.bind(target):value;
  }})),opts);
 });
 try{
  await owner.client.begin(async writer=>{
   await writer`select pg_advisory_xact_lock(hashtextextended(${'access-configuration:'+b.tenantId},0))`;
   const page=await rosterWindowPage(ctx,{companyIds:[b.companyId],...window,offset:24,limit:2});
   expect(page.total).toBe(31);expect(page.employees.map(e=>e.employmentId)).toEqual([ids[25],ids[26]]);expect(page.cells[cellKey(ids[25],window.from)]?.kind).toBe('shift');
  });
 }finally{spy.mockRestore();}
 expect(options).toEqual([{readOnlySnapshot:true}]);expect(changed).toBe(true);
 const cells=queries.filter(query=>query.sql.includes('from "roster_assignment"'));expect(cells).toHaveLength(1);
 expect(cells[0].params).toEqual(expect.arrayContaining([window.from,window.to,ids[25],ids[26]]));
 expect(cells[0].params).not.toContain(ids[1]);
 expect(queries.some(query=>/pg_advisory.*lock/.test(query.sql))).toBe(false);
});

it('rejects excess date windows before acquiring a transaction',async()=>{
 const b=await seedBase(),spy=vi.spyOn(database,'withTenant');
 try{expect(()=>rosterWindowPage(adminCtx(b),{companyIds:[b.companyId],from:'2027-01-01',to:'2027-12-31',offset:0,limit:25})).toThrow('at most');expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}
});

it('hydrates only 25 employees from the real 50k population',async()=>{
 const report:Record<string,unknown>={kind:'NATIVE_ROSTER_PRESENTATION_COMPONENT_ONLY',releaseEligible:false,employees:50000};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(join(process.env.AIHR_FOCUSED_EVIDENCE_DIR,'roster-presentation-50k.json'),JSON.stringify(report,null,2));};
 const {b,ctx,expectedFirst}=await seedPersonnelNativeFixture(50000,report,name=>{report.phase=name;save();},save);
 const started=performance.now(),page=await rosterWindowPage(ctx,{companyIds:[b.companyId],...window,offset:0,limit:25});
 report.pageMs=performance.now()-started;report.rows=page.employees.length;report.total=page.total;report.usualRows=Object.keys(page.usual).length;save();
 expect(page.total).toBe(40000);expect(page.employees).toHaveLength(25);expect(page.employees[0].employmentId).toBe(expectedFirst[0]);expect(page.allEmployees).toEqual([]);
 expect(Object.keys(page.cells).every(key=>page.employees.some(row=>key.startsWith(row.employmentId+'|')))).toBe(true);
 expect(Object.keys(page.usual).length).toBeLessThanOrEqual(25);expect(Object.keys(page.dayContext).length).toBeLessThanOrEqual(175);
},180000);
