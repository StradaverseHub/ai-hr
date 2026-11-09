/** Retained Personnel search fixture: initial full population versus on-demand bounded search. */
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {and,inArray,sql,type SQL} from 'drizzle-orm';
import {lockAccessConfigurationTx} from '../core/access-configuration-lock';
import * as s from '../db/schema';
import * as readers from '../core/read';
import {withTenant,type Tx} from '../db/client';
import {matchEmployees,foldEmployeeCode,EMPLOYEE_SEARCH_RESULT_CAP} from '../lib/employee-search';
import {adminCtx,closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';

// Frozen c27c bounded-query reference, specialized to its only filter: nonempty company IDs.
// Keep the original Drizzle expressions/ranking/lock; private test code, no production API.
const workforceListValue=<T>(key:string):SQL<T>=>sql<T>`workforce_row.value ->> ${key}`;
const workforceListUuid=(key:string)=>sql<string>`(${workforceListValue(key)})::uuid`;
function workforcePickerColumns(){return {
 employmentId:workforceListUuid('employmentId'),name:workforceListValue<string>('name'),
 employeeCode:workforceListValue<string|null>('employeeCode'),companyId:workforceListUuid('companyId'),
 company:workforceListValue<string>('company'),department:workforceListValue<string|null>('department'),
 terminatedOn:workforceListValue<string|null>('terminatedOn'),
};}
async function unmaterializedReference(ctx:ReturnType<typeof adminCtx>,tx:Tx,companyIds:string[],query:string){
  if(query.length>200)throw new RangeError('Invalid employee search');
  const raw=query.trim().toLowerCase(),folded=foldEmployeeCode(query);
  if(!raw||!companyIds.length)return [];
  await lockAccessConfigurationTx(tx,ctx.tenantId);
  const columns=workforcePickerColumns(),name=sql`lower(${columns.name})`,code=sql`lower(coalesce(${columns.employeeCode},''))`;
  const compact=sql`regexp_replace(${code}, '[[:space:]._-]', '', 'g')`;
  const rank=sql<number>`case
    when ${folded} <> '' and ${compact} <> '' and ${compact} = ${folded} then 0
    when ${folded} <> '' and ${compact} <> '' and left(${compact},length(${folded})) = ${folded} then 1
    when left(${name},length(${raw})) = ${raw} then 2
    when position(${raw} in ${code}) > 0 or (${folded} <> '' and position(${folded} in ${compact}) > 0) then 3
    when position(${raw} in ${name}) > 0 then 4 else 5 end`;
  const source=sql`app.access_workforce_picker_rows(null,null::date,null::date) as workforce_row(value)`;
  return tx.select(columns).from(source).where(and(inArray(columns.companyId,companyIds),sql`${rank} < 5`))
    .orderBy(rank,columns.name,columns.employmentId).limit(EMPLOYEE_SEARCH_RESULT_CAP);
}

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
 const search=Reflect.get(readers,'searchWorkforceEmployees') as undefined | ((ctx:ReturnType<typeof adminCtx>,companies:string[],query:string)=>Promise<typeof legacy>);
 const report:Record<string,unknown>={kind:'RETAINED_SEARCH_COMPONENT_NOT_SYSTEM_CAPACITY',visibleEmployments:employees.length,legacyRows:legacy.length,legacyMs,legacyBytes,searchImplemented:typeof search==='function',timeoutSeconds:240};
 const save=()=>{if(process.env.AIHR_FOCUSED_EVIDENCE_DIR)writeFileSync(process.env.AIHR_FOCUSED_EVIDENCE_DIR+'/personnel-switcher-volume.json',JSON.stringify(report));};
 save();expect(typeof search,'bounded search must replace eager whole-population navigation data').toBe('function');
 if(!search)throw new Error('Missing search reader');
 const read=(q:string,companies=[b.companyId])=>search(ctx,companies,q);
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
 const boundedPlanPairs=[];
 for(let round=0;round<4;round++){
  let referenceMs=0,normalizedMs=0;
  const reference=async()=>{const t=performance.now();const rows=await withTenant(ctx,tx=>unmaterializedReference(ctx,tx,[b.companyId],'MAIN0000'));referenceMs=performance.now()-t;expect(rows.map(fields)).toEqual(matchEmployees(legacy,'MAIN0000',8).map(fields));};
  const normalized=async()=>{const t=performance.now();const rows=await read('MAIN0000');normalizedMs=performance.now()-t;expect(rows.map(fields)).toEqual(matchEmployees(legacy,'MAIN0000',8).map(fields));};
  if(round%2===0){await reference();await normalized();}else{await normalized();await reference();}
  boundedPlanPairs.push({round,order:round%2===0?'reference-normalized':'normalized-reference',referenceMs,normalizedMs});
 }
 Object.assign(report,{pairedTimings:pairs,boundedPlanPairs,boundedReferenceSource:'c27ce14f69aea76576f198e5bcc50666136551e6_equivalentNonemptyCompanyOnlyFilter',boundedRows:8,boundedBytes,exactRankedMatches:true,emptyForeignScopeRefused:true});save();
},240000);
