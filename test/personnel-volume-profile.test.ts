/** Isolated retained-volume measurement; no public SQL or application change. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import * as s from '../db/schema';
import {withTenant} from '../db/client';
import {countEmployeesByStatus,listEmployeesPage,personnelListPage} from '../core/read';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

beforeAll(migrateTestDb);
afterAll(closeAll);

it('measures matched Personnel reads at 65536 permitted records with exact independent controls',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase(),ctx=adminCtx(b);
 const settings=await owner.client`select current_setting('shared_buffers') as shared_buffers,current_setting('work_mem') as work_mem,current_setting('jit') as jit,current_setting('max_connections') as max_connections`;
 expect((await withTenant(ctx,tx=>tx.execute(sql`select current_user as role`)))[0].role).toBe('ai_hr_app');
 type Fixture={id:string;index:number};const employees:Fixture[]=[];
 async function append(base:Base,from:number,to:number,prefix:string){
  const result:Fixture[]=[];
  for(let start=from;start<to;start+=256){
   const people=Array.from({length:Math.min(256,to-start)},(_,j)=>({id:randomUUID(),tenantId:base.tenantId,fullName:'Fictional Volume '+prefix+String(start+j).padStart(7,'0'),primaryEmail:prefix+(start+j)+'@example.invalid'}));
   const rows=people.map((p,j)=>({id:randomUUID(),tenantId:base.tenantId,personId:p.id,companyId:base.companyId,employeeCode:prefix+String(start+j).padStart(7,'0'),hiredOn:'2020-01-01',terminatedOn:(start+j)%5===0?'2024-01-01':null}));
   await owner.db.insert(s.person).values(people);await owner.db.insert(s.employment).values(rows);
   await owner.db.insert(s.assignment).values(rows.map((e,j)=>({tenantId:base.tenantId,employmentId:e.id,companyId:base.companyId,departmentId:(start+j)%2===0?base.deptA:base.deptB,employmentType:'full_time' as const,validFrom:'2020-01-01'})));
   result.push(...rows.map((r,j)=>({id:r.id,index:start+j})));
  }
  return result;
 }
 await append(foreign,0,7,'FOREIGN');
 const empty={rows:[],total:0,headcount:{total:0,byStatus:{}}};
 const report={kind:'NATIVE_PERSONNEL_RETAINED_VOLUME_NOT_HTTP_OR_CAPACITY',settings,cardinalities:[] as Record<string,unknown>[],complete:false,controlsComplete:false,readerBudgetMs:1000,limitations:'Single authorized HR reader, fictional owner-seeded retained records, not hiring throughput, not concurrent HTTP/browser or millions of Personnel records. No settings, public SQL, provider access or deployment changes.'};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(process.env.AIHR_FOCUSED_EVIDENCE_DIR+'/personnel-volume-profile.json',JSON.stringify(report));};save();
 const page={companyIds:[b.companyId],limit:25,offset:0},facets={companyIds:[b.companyId]};
 const legacy=async(p:Parameters<typeof personnelListPage>[1]=page,f:Parameters<typeof personnelListPage>[2]=facets)=>{const [rows,headcount]=await Promise.all([listEmployeesPage(ctx,p,'workforce'),countEmployeesByStatus(ctx,f,'workforce')]);return {...rows,headcount};};
 try{
  for(const size of [65536]){
   const seedStart=performance.now();employees.push(...await append(b,employees.length,size,'MAIN'));const seedMs=performance.now()-seedStart;
   // Update planner statistics for this volume in the disposable runner database only.
   await owner.client.unsafe('ANALYZE person, employment, assignment');
   const expected=await legacy();const resigned=employees.filter(e=>e.index%5===0).length;
   expect(expected.total).toBe(size);expect(expected.rows.map(r=>r.employmentId)).toEqual(employees.slice(0,25).map(e=>e.id));
   expect(expected.headcount).toEqual({total:size,byStatus:{active:size-resigned,resigned}});
   const timings:{round:number;order:string;legacyMs:number;composedMs:number}[]=[];
   const item={visibleEmployments:size,foreignEmployments:7,seedMs,timings,rssBefore:process.memoryUsage().rss,rssAfter:0,legacyMeanMs:0,composedMeanMs:0,composedWithinSingleReadBudget:false,exactControls:false};report.cardinalities.push(item);save();
   for(let round=0;round<4;round++){
    let legacyMs=0,composedMs=0;
    const old=async()=>{const t=performance.now();const result=await legacy();legacyMs=performance.now()-t;expect(result).toEqual(expected);};
    const current=async()=>{const t=performance.now();const result=await personnelListPage(ctx,page,facets);composedMs=performance.now()-t;expect(result).toEqual(expected);};
    if(round%2===0){await old();await current();}else{await current();await old();}
    timings.push({round,order:round%2===0?'legacy-composed':'composed-legacy',legacyMs,composedMs});save();
   }
   item.legacyMeanMs=timings.reduce((n,t)=>n+t.legacyMs,0)/timings.length;item.composedMeanMs=timings.reduce((n,t)=>n+t.composedMs,0)/timings.length;
   item.composedWithinSingleReadBudget=timings.every(t=>t.composedMs<report.readerBudgetMs);item.rssAfter=process.memoryUsage().rss;
   for(const offset of [25,size-25]){
    const p={...page,offset},expectedPage=await legacy(p);expect(await personnelListPage(ctx,p,facets)).toEqual(expectedPage);
    expect(expectedPage.rows.map(r=>r.employmentId)).toEqual(employees.slice(offset,offset+25).map(e=>e.id));
   }
   const p={...page,departmentId:b.deptB},f={...facets,departmentId:b.deptB};
   const department=await personnelListPage(ctx,p,f);expect(department).toEqual(await legacy(p,f));expect(department.total).toBe(employees.filter(e=>e.index%2===1).length);
   const filtered:Parameters<typeof personnelListPage>[1]={...page,employmentStatuses:['resigned']};const filteredResult=await personnelListPage(ctx,filtered,facets);
   expect(filteredResult).toEqual(await legacy(filtered));expect(filteredResult.total).toBe(resigned);expect(filteredResult.headcount).toEqual(expected.headcount);
   expect(await personnelListPage(ctx,{...page,companyIds:[]},{companyIds:[]})).toEqual(empty);
   expect(await personnelListPage(ctx,{...page,companyIds:[foreign.companyId]},{companyIds:[foreign.companyId]})).toEqual(empty);
   item.exactControls=true;save();
  }
  const [ungranted]=await owner.db.insert(s.appUser).values({tenantId:b.tenantId,workosUserId:'volume_ungranted_'+randomUUID()}).returning({id:s.appUser.id});
  const forged={...ctx,userId:ungranted.id,roles:['hr_admin'],grants:[{role:'hr_admin',companyId:null}]};
  const forgedLegacy=await Promise.all([listEmployeesPage(forged,page,'workforce'),countEmployeesByStatus(forged,facets,'workforce')]);
  expect({...forgedLegacy[0],headcount:forgedLegacy[1]}).toEqual(empty);expect(await personnelListPage(forged,page,facets)).toEqual(empty);
  report.controlsComplete=true;report.complete=true;
 }finally{save();}
},240000);
