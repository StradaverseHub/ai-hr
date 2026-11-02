/** Retained Personnel search fixture: initial full population versus on-demand bounded search. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {sql} from 'drizzle-orm';
import * as s from '../db/schema';
import * as readers from '../core/read';
import {withTenant,type Tx} from '../db/client';
import {matchEmployees} from '../lib/employee-search';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
beforeAll(migrateTestDb);afterAll(closeAll);
it('keeps the exact authorized search matches with bounded response at retained volume',async()=>{
 await resetDb();const b=await seedBase(),foreign=await seedBase();
 async function population(base:Base,size:number,prefix:string){
  const people=Array.from({length:size},(_,i)=>({id:randomUUID(),tenantId:base.tenantId,fullName:'Fictional Personnel '+prefix+String(i).padStart(6,'0'),primaryEmail:prefix+i+'@example.invalid'}));
  const employments=people.map((p,i)=>({id:randomUUID(),tenantId:base.tenantId,personId:p.id,companyId:base.companyId,employeeCode:prefix+String(i).padStart(6,'0'),hiredOn:'2020-01-01',terminatedOn:i%5===0?'2024-01-01':null}));
  for(let offset=0;offset<size;offset+=256){
   await owner.db.insert(s.person).values(people.slice(offset,offset+256));
   await owner.db.insert(s.employment).values(employments.slice(offset,offset+256));
   await owner.db.insert(s.assignment).values(employments.slice(offset,offset+256).map((e,i)=>({tenantId:base.tenantId,employmentId:e.id,companyId:base.companyId,departmentId:i%2===0?base.deptA:base.deptB,employmentType:'full_time' as const,validFrom:'2020-01-01'})));
  }
  return employments;
 }

 const employees=await population(b,16384,'MAIN');await population(foreign,7,'FOREIGN');const ctx=adminCtx(b);
 expect((await withTenant(ctx,tx=>tx.execute(sql`select current_user as role`)))[0].role).toBe('ai_hr_app');
 const start=performance.now(),legacy=await readers.listWorkforcePickOptions(ctx,[b.companyId]);
 const legacyMs=performance.now()-start;
 expect(legacy).toHaveLength(employees.length);
 const fields=({employmentId,name,employeeCode,company,department}:typeof legacy[number])=>({employmentId,name,employeeCode,company,department});
 const legacyBytes=Buffer.byteLength(JSON.stringify(legacy.map(fields)));
 const search=Reflect.get(readers,'searchWorkforceEmployeesTx') as undefined | ((ctx:ReturnType<typeof adminCtx>,tx:Tx,companies:string[],query:string)=>Promise<typeof legacy>);
 const report:Record<string,unknown>={kind:'RETAINED_SEARCH_COMPONENT_NOT_SYSTEM_CAPACITY',visibleEmployments:employees.length,legacyRows:legacy.length,legacyMs,legacyBytes,searchImplemented:typeof search==='function',timeoutSeconds:240};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(process.env.AIHR_FOCUSED_EVIDENCE_DIR+'/personnel-switcher-volume.json',JSON.stringify(report));};
 save();expect(typeof search,'bounded search must replace eager whole-population navigation data').toBe('function');
 if(!search)throw new Error('Missing search reader');
 const read=(q:string,companies=[b.companyId])=>withTenant(ctx,tx=>search(ctx,tx,companies,q));
 for(const q of ['MAIN0000','main000008','00008','fictional personnel main','%_','   ']){
  expect((await read(q)).map(fields)).toEqual(matchEmployees(legacy,q,8).map(fields));
 }
 expect((await read('main000008'))[0].employmentId).toBe(employees[8].id);
 expect(await read('MAIN',[])).toEqual([]);expect(await read('FOREIGN',[foreign.companyId])).toEqual([]);
 await expect(read('x'.repeat(201))).rejects.toThrow('Invalid employee search');
 const pairs=[];let boundedBytes=0;
 for(let round=0;round<4;round++){
  let eagerMs=0,boundedMs=0;
  const eager=async()=>{const t=performance.now();const rows=await readers.listWorkforcePickOptions(ctx,[b.companyId]);eagerMs=performance.now()-t;expect(rows.map(fields)).toEqual(legacy.map(fields));};
  const bounded=async()=>{const t=performance.now();const rows=await read('MAIN0000');boundedMs=performance.now()-t;expect(rows.map(fields)).toEqual(matchEmployees(legacy,'MAIN0000',8).map(fields));boundedBytes=Buffer.byteLength(JSON.stringify(rows.map(fields)));expect(rows).toHaveLength(8);};
  if(round%2===0){await eager();await bounded();}else{await bounded();await eager();}
  pairs.push({round,eagerMs,boundedMs});
 }
 Object.assign(report,{pairedTimings:pairs,boundedRows:8,boundedBytes,exactRankedMatches:true,emptyForeignScopeRefused:true});save();
},240000);
