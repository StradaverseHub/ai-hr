/** ADR 0181 decision 5 (Phase 4): the Attendance month summary (/attendance) pages by key and caps its total.
 *
 * On the fictional 71-company / 1,040-employment group (test/helpers/ai-centre-scale-fixture.ts, whose names are
 * unique, so the previous name-only order is fully determined), for the group, company-by-company and single-company
 * administrators under "All companies" and one company, it proves against the previous OFFSET reader
 * (attendanceMonthSummaryPage):
 *  - equivalence: Next to the end and Previous back from Last return the previous reader's hydrated month rows in
 *    its order, nothing repeated or skipped;
 *  - totals: exact below 1,000, "1,000+" above, "Count exactly" equal to the previous total;
 *  - authority: an employment the viewer cannot see never anchors a page;
 *  - cost: one-parameter company list, the same list statements for one company and 71 companies, no OFFSET.
 * All names are invented. */
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {allowedCompanies} from '../core/read';
import {attendanceMonthSummaryKeysetPage,attendanceMonthSummaryPage} from '../packs/attendance/service';
import {LIST_COUNT_CAP,parseKeysetPageQuery,parsePageQuery,type KeysetPageQuery} from '../lib/pagination';
import {closeAll,migrateTestDb,resetDb,seedBase} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {observeStatements} from './helpers/statement-observer';

let fixture:ScaleFixture;
const MONTH='2026-05',TODAY='2026-05-20';
beforeAll(async()=>{
 await migrateTestDb();await resetDb();const b=await seedBase();
 fixture=await buildScaleFixture(b,{employments:1040,events:0});
},300_000);
afterAll(closeAll);

type Row=Awaited<ReturnType<typeof attendanceMonthSummaryPage>>['rows'][number];
const scopeIds=async(ctx:SessionContext,scope:'all'|'one')=>scope==='one'?[fixture.companyIds[0]]:(await allowedCompanies(ctx)).map(c=>c.id);
async function previous(ctx:SessionContext,companyIds:string[]){
 const rows:Row[]=[];let total=0;
 for(let page=0;;page++){
  const read=await attendanceMonthSummaryPage(ctx,{month:MONTH,today:TODAY,companyIds,page:parsePageQuery({page:String(page),size:'200'})});
  rows.push(...read.rows);total=read.state.total;
  if(read.rows.length<200)break;
 }
 return {rows,total};
}
const page=(ctx:SessionContext,companyIds:string[],q:KeysetPageQuery)=>attendanceMonthSummaryKeysetPage(ctx,{month:MONTH,today:TODAY,companyIds,page:q});
async function walk(ctx:SessionContext,companyIds:string[],size:string,backwards=false){
 const pages:Row[][]=[],totals:{count:number;capped:boolean}[]=[];
 let q=parseKeysetPageQuery(backwards?{size,last:'1'}:{size}),n=0;
 for(;;){
  const read=await page(ctx,companyIds,q);n++;
  expect(read.anchorFound).toBe(true);
  backwards?pages.unshift(read.rows):pages.push(read.rows);totals.push(read.total);
  if(backwards?!read.hasPrev:!read.hasNext)break;
  q=parseKeysetPageQuery(backwards?{size,page:'3',before:read.rows[0].employmentId}:{size,page:String(n),after:read.rows.at(-1)!.employmentId});
  expect(n,'the walk terminates').toBeLessThan(200);
 }
 return {rows:pages.flat(),totals};
}
const ids=(rows:readonly {employmentId:string}[])=>rows.map(r=>r.employmentId);

describe('Attendance month summary keyset paging at group scale',()=>{
 it('returns the previous reader\'s month rows in its order, forwards and backwards, for every administrator and scope',async()=>{
  expect(fixture.companyIds.length).toBeGreaterThanOrEqual(70);
  let crossedCap=false,belowCap=false;
  for(const [name,ctx] of Object.entries(fixture.personas)){
   for(const scope of ['all','one'] as const){
    const companyIds=await scopeIds(ctx,scope),label=`${name}/${scope}`;
    const expected=await previous(ctx,companyIds);
    if(name!=='single'||scope==='all')expect(expected.rows.length,`${label}: nonempty authorized source`).toBeGreaterThan(0);
    const forward=await walk(ctx,companyIds,'200');
    expect(new Set(ids(forward.rows)).size,`${label}: no repeats`).toBe(forward.rows.length);
    expect(ids(forward.rows),`${label}: same people, same order`).toEqual(ids(expected.rows));
    expect(forward.rows,`${label}: same month figures`).toEqual(expected.rows);
    for(const total of forward.totals)
     expect(total,`${label}: capped total`).toEqual(expected.total>LIST_COUNT_CAP?{count:LIST_COUNT_CAP,capped:true}:{count:expected.total,capped:false});
    if(expected.total>LIST_COUNT_CAP){
     crossedCap=true;
     expect((await page(ctx,companyIds,parseKeysetPageQuery({count:'exact'}))).total,`${label}: Count exactly`).toEqual({count:expected.total,capped:false});
    }else if(expected.total>25){
     belowCap=true;
     expect(ids((await walk(ctx,companyIds,'25',true)).rows),`${label}: Previous from Last`).toEqual(ids(expected.rows));
    }
   }
  }
  expect(crossedCap&&belowCap,'the scopes cover both sides of the cap').toBe(true);
 },600_000); // 3 administrators x 2 scopes of month hydration over ~1,040 employments; hosted runners need headroom.

 it('never pages relative to an employment the viewer cannot see',async()=>{
  const ctx=fixture.personas.single,companyIds=await scopeIds(ctx,'all');
  const seen=new Set((await withTenant(ctx,tx=>tx.select({id:schema.employment.id}).from(schema.employment))).map(r=>r.id));
  const hidden=fixture.employmentIds.find(id=>!seen.has(id));
  expect(hidden).toBeDefined();
  const first=await page(ctx,companyIds,parseKeysetPageQuery({size:'25'}));
  for(const cursor of [{after:hidden!},{before:hidden!},{after:randomUUID()}]){
   const read=await page(ctx,companyIds,parseKeysetPageQuery({size:'25',page:'4',...cursor}));
   expect(read.anchorFound).toBe(false);expect(read.hasPrev).toBe(false);
   expect(ids(read.rows)).toEqual(ids(first.rows));
  }
 },120_000);

 it('costs the same list statements for one company and 71 companies',async()=>{
  for(const [name,ctx] of [['group',fixture.personas.group],['multi',fixture.personas.multi]] as const){
   const all=await scopeIds(ctx,'all'),one=await scopeIds(ctx,'one');
   await page(ctx,one,parseKeysetPageQuery({size:'25'})); // warm per-process caches
   const a=await observeStatements(()=>page(ctx,all,parseKeysetPageQuery({size:'25'})));
   const o=await observeStatements(()=>page(ctx,one,parseKeysetPageQuery({size:'25'})));
   expect(a.transactions,`${name}: one transaction`).toBe(1);
   const list=(s:{sql:string;params:readonly unknown[]}[])=>s.filter(x=>/from "employment" inner join "person"/.test(x.sql)).map(x=>[x.sql,x.params.length]);
   expect(list(a.statements).length,`${name}: page and capped count`).toBe(2);
   expect(list(a.statements),`${name}: same list statements and parameter counts`).toEqual(list(o.statements));
   for(const statement of a.statements)expect(statement.sql,`${name}: no OFFSET`).not.toMatch(/\boffset\b/i);
  }
 },120_000);
});
