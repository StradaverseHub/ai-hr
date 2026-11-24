/** ADR 0181 decision 5 (Phase 4): Daily Attendance (/attendance/daily) pages by key and caps its total.
 *
 * On the fictional 71-company / 1,040-employment group (test/helpers/ai-centre-scale-fixture.ts), with some
 * employments given no employee code (the list puts blanks last), some attendance days and a search, for the group,
 * company-by-company and single-company administrators under "All companies" and one company, it proves against the
 * previous OFFSET reader (attendanceForDatePage):
 *  - equivalence: walking Next to the end, and Previous back from Last, returns the previous reader's derived day
 *    rows in its order (code with blanks last, name, id), nothing repeated or skipped;
 *  - totals: exact below 1,000, "1,000+" above, and "Count exactly" equal to the previous total;
 *  - authority: a cursor naming an employment the viewer cannot see serves the first page;
 *  - cost: the list statements are identical for one company and 71 companies, and the page's day derivation
 *    reads the same statements for both (it depends on the page's 25 people, never on the company count).
 * All names and figures are invented. */
import {randomUUID} from 'node:crypto';
import {sql} from 'drizzle-orm';
import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import {withTenant,type SessionContext} from '../db/client';
import * as schema from '../db/schema';
import {attendanceForDateKeysetPage,attendanceForDatePage} from '../core/attendance';
import {allowedCompanies} from '../core/read';
import {todayInKualaLumpur} from '../lib/hr-date';
import {LIST_COUNT_CAP,parseKeysetPageQuery,type KeysetPageQuery} from '../lib/pagination';
import {closeAll,migrateTestDb,owner,resetDb,seedBase,type Base} from './harness';
import {buildScaleFixture,type ScaleFixture} from './helpers/ai-centre-scale-fixture';
import {observeStatements} from './helpers/statement-observer';

let b:Base,fixture:ScaleFixture;
const day=todayInKualaLumpur();
beforeAll(async()=>{
 await migrateTestDb();await resetDb();b=await seedBase();
 fixture=await buildScaleFixture(b,{employments:1040,events:0});
 // Blank employee codes on 30 employments spread over the companies: the list shows them after every coded one.
 await owner.client`update employment set employee_code=null
  where id = any(${'{'+fixture.activeEmploymentIds.filter((_,i)=>i%31===4).slice(0,30).join(',')+'}'}::uuid[])`;
 // A worked day for every fifth active employment, so the derivation has attendance rows to carry.
 const worked=fixture.activeEmploymentIds.filter((_,i)=>i%5===0);
 for(let i=0;i<worked.length;i+=500)
  await owner.db.insert(schema.attendance).values(worked.slice(i,i+500).map(employmentId=>({tenantId:b.tenantId,employmentId,attendanceDate:day,
   checkInAt:'09:00:00',checkOutAt:'18:00:00',status:'present' as const})));
},300_000);
afterAll(closeAll);

type Scope='all'|'one';
const scopeIds=async(ctx:SessionContext,scope:Scope)=>scope==='one'?[fixture.companyIds[0]]:(await allowedCompanies(ctx)).map(c=>c.id);
type Filters={q?:string};
type Row=Awaited<ReturnType<typeof attendanceForDatePage>>['rows'][number];
async function previous(ctx:SessionContext,companyIds:string[],f:Filters){
 const rows:Row[]=[];let total=0;
 for(let offset=0;;offset+=2000){const page=await attendanceForDatePage(ctx,day,companyIds,{...f,limit:2000,offset});rows.push(...page.rows);total=page.total;if(page.rows.length<2000)break;}
 return {rows,total};
}
const page=(ctx:SessionContext,companyIds:string[],f:Filters,q:KeysetPageQuery)=>attendanceForDateKeysetPage(ctx,day,companyIds,{...f,...q});
async function walkForward(ctx:SessionContext,companyIds:string[],f:Filters,size:string){
 const rows:Row[]=[],totals:{count:number;capped:boolean}[]=[];
 let q=parseKeysetPageQuery({size}),n=0;
 for(;;){
  const read=await page(ctx,companyIds,f,q);n++;
  expect(read.anchorFound).toBe(true);expect(read.hasPrev).toBe(n>1);
  rows.push(...read.rows);totals.push(read.total);
  if(!read.hasNext)break;
  q=parseKeysetPageQuery({size,page:String(n),after:read.rows.at(-1)!.employmentId});
  expect(n,'the walk terminates').toBeLessThan(200);
 }
 return {rows,totals};
}
async function walkBackward(ctx:SessionContext,companyIds:string[],f:Filters,size:string){
 const pages:Row[][]=[];
 let q=parseKeysetPageQuery({size,last:'1'});
 for(;;){
  const read=await page(ctx,companyIds,f,q);pages.unshift(read.rows);
  if(!read.hasPrev)break;
  q=parseKeysetPageQuery({size,page:'3',before:read.rows[0].employmentId});
  expect(pages.length,'the walk terminates').toBeLessThan(200);
 }
 return pages.flat();
}
const ids=(rows:readonly {employmentId:string}[])=>rows.map(r=>r.employmentId);

describe('Daily Attendance keyset paging at group scale',()=>{
 it('reads the previous reader\'s day rows in its order, forwards and backwards, for every administrator and scope',async()=>{
  expect(fixture.companyIds.length).toBeGreaterThanOrEqual(70);
  let crossedCap=false,belowCap=false,sawBlankCodes=false;
  for(const [name,ctx] of Object.entries(fixture.personas)){
   for(const scope of ['all','one'] as const){
    const companyIds=await scopeIds(ctx,scope);
    for(const [label,f] of Object.entries({everything:{},search:{q:'tan'}} as Record<string,Filters>)){
     const expected=await previous(ctx,companyIds,f);
     if(name!=='single'||scope==='all')expect(expected.rows.length,`${name}/${scope}/${label}: nonempty authorized source`).toBeGreaterThan(0);
     expect(expected.rows.length,`${name}/${scope}/${label}: previous total agrees`).toBe(expected.total);
     const forward=await walkForward(ctx,companyIds,f,'200');
     expect(ids(forward.rows),`${name}/${scope}/${label}: same people, same order`).toEqual(ids(expected.rows));
     expect(forward.rows,`${name}/${scope}/${label}: same derived day`).toEqual(expected.rows);
     sawBlankCodes||=forward.rows.some(r=>r.employeeCode===null)&&forward.rows.at(-1)!.employeeCode===null;
     for(const total of forward.totals)
      expect(total,`${name}/${scope}/${label}: capped total`).toEqual(expected.total>LIST_COUNT_CAP?{count:LIST_COUNT_CAP,capped:true}:{count:expected.total,capped:false});
     if(expected.total>LIST_COUNT_CAP){
      crossedCap=true;
      expect((await page(ctx,companyIds,f,parseKeysetPageQuery({count:'exact'}))).total,`${name}/${scope}/${label}: Count exactly`).toEqual({count:expected.total,capped:false});
     }else if(expected.total>25){
      belowCap=true;
      expect(ids(await walkBackward(ctx,companyIds,f,'25')),`${name}/${scope}/${label}: Previous from Last`).toEqual(ids(expected.rows));
     }
    }
   }
  }
  expect(crossedCap&&belowCap,'the scopes cover both sides of the cap').toBe(true);
  expect(sawBlankCodes,'blank employee codes are walked, last').toBe(true);
 },300_000); // 3 administrators x 2 scopes x 2 filters of 200-row walks deriving ~1,000 days each; hosted headroom.

 it('never pages relative to an employment the viewer cannot see',async()=>{
  const ctx=fixture.personas.single,companyIds=await scopeIds(ctx,'all');
  const seen=new Set((await withTenant(ctx,tx=>tx.select({id:schema.employment.id}).from(schema.employment))).map(r=>r.id));
  const hidden=fixture.employmentIds.find(id=>!seen.has(id));
  expect(hidden,'an employment hidden from the single-company administrator').toBeDefined();
  const first=await page(ctx,companyIds,{},parseKeysetPageQuery({size:'25'}));
  for(const cursor of [{after:hidden!},{before:hidden!},{after:randomUUID()}]){
   const read=await page(ctx,companyIds,{},parseKeysetPageQuery({size:'25',page:'4',...cursor}));
   expect(read.anchorFound).toBe(false);expect(read.hasPrev).toBe(false);
   expect(ids(read.rows)).toEqual(ids(first.rows));
  }
 },60_000);

 it('costs the same statements for one company and 71 companies',async()=>{
  for(const [name,ctx] of [['group',fixture.personas.group],['multi',fixture.personas.multi]] as const){
   const run=async(scope:Scope,cursor:Record<string,string>={})=>
    observeStatements(()=>page(ctx,await scopeIds(ctx,scope),{},parseKeysetPageQuery({size:'25',...cursor})));
   const all=await run('all'),one=await run('one');
   expect((await scopeIds(ctx,'all')).length,`${name}: All companies is the group`).toBeGreaterThanOrEqual(70);
   expect(all.result.hasNext&&one.result.hasNext,`${name}: both scopes have a next page`).toBe(true);
   const pairs=[['first page',all,one],['next page',await run('all',{page:'1',after:all.result.rows.at(-1)!.employmentId}),
    await run('one',{page:'1',after:one.result.rows.at(-1)!.employmentId})]] as const;
   for(const [label,a,o] of pairs){
    expect(a.transactions,`${name}/${label}: one transaction`).toBe(1);
    // The id page and the capped count: the same text and one company-list parameter whatever the scope.
    const list=(s:{sql:string}[])=>s.filter(x=>/^select "employment"\."id" from|count\(\*\)::int from \(select 1/.test(x.sql)).map(x=>x.sql);
    expect(list(a.statements).length,`${name}/${label}: two list statements`).toBe(2);
    expect(list(a.statements),`${name}/${label}: same list statements`).toEqual(list(o.statements));
    // The day derivation depends on the page's people, not the number of companies in scope.
    expect(a.statements.length,`${name}/${label}: statements`).toBeLessThanOrEqual(o.statements.length+2);
    for(const statement of a.statements)expect(statement.sql,`${name}/${label}: no OFFSET`).not.toMatch(/\boffset\b/i);
   }
  }
 },120_000);
});
